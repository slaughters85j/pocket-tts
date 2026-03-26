"""Fish-Speech MLX backend — wraps mlx_audio's Fish Audio S2 Pro model.

This backend is conditionally available.  It requires ``mlx-audio >= 0.4.1``
and Apple Silicon (MLX).  When the dependency is missing the backend will not
appear in ``get_available_backends()``.

The model generates audio in per-batch segments (segment-level streaming),
not per-frame like pocket-tts.  Each yield is one sentence/batch worth of
audio.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import torch

logger = logging.getLogger(__name__)

# Default model path — checks local models/ dir first, falls back to HuggingFace repo ID.
# Override with FISH_SPEECH_MODEL_PATH env var.
_LOCAL_MODEL_DIR = Path(__file__).parent.parent.parent / "models" / "fish-audio-s2-pro-8bit"
_DEFAULT_MODEL_PATH = os.environ.get(
    "FISH_SPEECH_MODEL_PATH",
    str(_LOCAL_MODEL_DIR) if _LOCAL_MODEL_DIR.exists() else "mlx-community/fish-audio-s2-pro-8bit",
)


# ------------------------------------------------------------------
# Voice state dataclass
# ------------------------------------------------------------------


def _normalize_audio_rms(audio: torch.Tensor, target_db: float = -16.0) -> torch.Tensor:
    """Normalize audio to a target RMS level in dB, clipped to [-1, 1].

    Matches the behavior of ``TTSModel._normalize_audio_rms`` from the
    pocket-tts backend so that voice normalization modes (per-voice,
    match loudest, match quietest) produce consistent output levels.
    """
    rms = audio.square().mean().sqrt()
    if rms < 1e-8:
        return audio  # silence — don't amplify noise
    target_rms = 10 ** (target_db / 20.0)
    gain = target_rms / rms
    return (audio * gain).clamp(-1.0, 1.0)


@dataclass(frozen=True)
class FishVoiceState:
    """Opaque voice state for fish-speech.

    Unlike pocket-tts's heavy dict of hidden-state tensors, fish-speech
    just needs the path to a reference WAV file (or None for default voice).
    """

    ref_audio_path: str | None = None
    ref_text: str | None = None
    target_db: float = -16.0  # RMS normalization target for output audio


# Regex for [Xs] pause markers — used to convert to native fish-speech pause tags
_PAUSE_MARKER_RE = re.compile(r"\[(\d+(?:\.\d+)?)s\]", re.IGNORECASE)


def _convert_pause_markers_to_tags(text: str) -> str:
    """Convert pocket-tts ``[Xs]`` pause markers to fish-speech native pause tags.

    Instead of splitting the text and inserting silence (which breaks tag context
    across the Dual-AR), we replace pause markers with native tags that the model
    handles in-context:

    - ``< 0.5s``  → ``[short pause]``
    - ``0.5–2s``  → ``[pause]``
    - ``> 2s``    → ``[long pause]``
    """

    def _replace(m: re.Match) -> str:
        duration = float(m.group(1))
        if duration < 0.5:
            return "[short pause]"
        elif duration <= 2.0:
            return "[pause]"
        else:
            return "[long pause]"

    return _PAUSE_MARKER_RE.sub(_replace, text)


# ------------------------------------------------------------------
# Monkey-patch for mlx-audio sanitize() bug
# ------------------------------------------------------------------


def _apply_sanitize_patch() -> None:
    """Patch mlx-audio <= 0.4.1 sanitize() for MLX-native weight prefixes.

    The upstream sanitize() only handles PyTorch-style prefixes
    (``text_model.model.*`` and ``audio_decoder.*``) but MLX-community
    converted models use a bare ``model.*`` prefix.  Without this patch all
    weights are silently dropped, causing a "Missing 358 parameters" error.

    This patch is idempotent — calling it multiple times is safe.

    TODO: File upstream issue and remove once fixed.
    """
    try:
        from mlx_audio.tts.models.fish_qwen3_omni import fish_speech as _fs_mod

        Model = _fs_mod.Model
        original = Model.sanitize

        # Guard against double-patching
        if getattr(original, "_pocket_tts_patched", False):
            return

        def patched_sanitize(self, weights: dict) -> dict:
            """Sanitize with MLX-native model.* prefix pass-through."""
            remapped: dict = {}
            for key, value in weights.items():
                if key.startswith("text_model.model."):
                    new_key = key[len("text_model.model.") :]
                elif key.startswith("audio_decoder."):
                    suffix = key[len("audio_decoder.") :]
                    if suffix.startswith("codebook_embeddings."):
                        new_key = suffix
                    else:
                        new_key = f"fast_{suffix}"
                elif key.startswith("model."):
                    # MLX-native weights — pass through as-is
                    remapped[key] = value
                    continue
                else:
                    continue
                remapped[f"model.{new_key}"] = value
            return remapped

        patched_sanitize._pocket_tts_patched = True  # type: ignore[attr-defined]
        Model.sanitize = patched_sanitize
        logger.debug("Applied mlx-audio sanitize() monkey-patch for MLX-native weights")
    except (ImportError, AttributeError) as exc:
        logger.warning("Could not apply sanitize() patch: %s", exc)


def _apply_generate_patch() -> None:
    """Patch ``model.generate()`` to accept pre-encoded codec indices.

    When ``ref_codes`` (mx.array, shape ``[10, T]``) and ``ref_codes_length``
    (int) are passed via kwargs, the codec encoding step is skipped entirely.
    This eliminates re-encoding the same reference audio on every call.

    This patch is idempotent.
    """
    try:
        from mlx_audio.tts.models.fish_qwen3_omni import fish_speech as _fs_mod

        Model = _fs_mod.Model
        original_generate = Model.generate

        if getattr(original_generate, "_pocket_tts_codec_patched", False):
            return

        import mlx.core as mx

        def patched_generate(self, text, voice=None, ref_audio=None, ref_text=None, **kwargs):
            # Extract our custom params before they hit the original `del kwargs`
            ref_codes = kwargs.pop("ref_codes", None)
            ref_codes_length = kwargs.pop("ref_codes_length", None)

            if ref_codes is not None and ref_codes_length is not None:
                # Bypass codec encoding — inject cached indices directly
                del voice
                if kwargs.get("stream", False):
                    raise NotImplementedError("Fish Speech streaming is not implemented yet.")
                if self.tokenizer is None:
                    raise ValueError("Tokenizer not loaded. Call post_load_hook first.")
                if self.codec is None:
                    raise ValueError("Codec not loaded. Call post_load_hook first.")

                prompt_tokens = [ref_codes[:, :ref_codes_length]]
                prompt_texts = [ref_text or ""]

                base_conversation = self._build_conversation(prompt_texts, prompt_tokens)

                # Pop our params, delegate the rest of the generation loop
                # to the original code path by calling with ref_audio=None
                # But we need the conversation — so replicate the loop here.
                import time

                from mlx_audio.tts.models.base import GenerationResult
                from mlx_audio.tts.models.fish_qwen3_omni.fish_speech import (
                    _adjust_speed,
                    _format_duration,
                )
                from mlx_audio.tts.models.fish_qwen3_omni.prompt import (
                    Conversation,
                    Message,
                    TextPart,
                    VQPart,
                    group_turns_into_batches,
                    split_text_by_speaker,
                )

                max_tokens = kwargs.get("max_tokens", 1024)
                temperature = kwargs.get("temperature", 0.7)
                top_p = kwargs.get("top_p", 0.7)
                top_k = kwargs.get("top_k", 30)
                speed = kwargs.get("speed", 1.0)
                chunk_length = kwargs.get("chunk_length", 300)

                turns = split_text_by_speaker(text)
                batches = (
                    group_turns_into_batches(turns, max_speakers=5, max_bytes=chunk_length)
                    if turns
                    else [text]
                )

                conversation = Conversation(list(base_conversation.messages))
                segment_idx = 0
                for batch_text in batches:
                    conversation.append(
                        Message(
                            role="user",
                            parts=[TextPart(batch_text)],
                            add_im_start=True,
                            add_im_end=True,
                        )
                    )
                    start_time = time.perf_counter()
                    codes = self._generate_codes_for_batch(
                        conversation=conversation,
                        batch_text=batch_text,
                        max_new_tokens=max_tokens,
                        top_p=top_p,
                        top_k=top_k,
                        temperature=temperature,
                    )
                    audio = self._decode_codes(codes)
                    if abs(speed - 1.0) > 1e-6:
                        audio = _adjust_speed(audio, speed)
                    mx.eval(audio, codes)

                    conversation.append(
                        Message(
                            role="assistant",
                            parts=[VQPart(codes)],
                            modality="voice",
                            add_im_start=True,
                            add_im_end=True,
                        )
                    )

                    elapsed = max(time.perf_counter() - start_time, 1e-6)
                    audio_duration = float(audio.shape[0]) / float(self.sample_rate)
                    prompt_tokens_count = len(self.tokenizer.encode(batch_text))
                    yield GenerationResult(
                        audio=audio,
                        samples=int(audio.shape[0]),
                        sample_rate=self.sample_rate,
                        segment_idx=segment_idx,
                        token_count=int(codes.shape[1]),
                        audio_duration=_format_duration(audio_duration),
                        real_time_factor=audio_duration / elapsed if elapsed > 0 else 0.0,
                        prompt={
                            "tokens": prompt_tokens_count,
                            "tokens-per-sec": (
                                prompt_tokens_count / elapsed if elapsed > 0 else 0.0
                            ),
                        },
                        audio_samples={
                            "samples": int(audio.shape[0]),
                            "samples-per-sec": (
                                float(audio.shape[0]) / elapsed if elapsed > 0 else 0.0
                            ),
                        },
                        processing_time_seconds=elapsed,
                        peak_memory_usage=float(mx.get_peak_memory() / 1e9),
                    )
                    segment_idx += 1
            else:
                # No cached codes — fall through to original generate()
                yield from original_generate(
                    self, text, voice=voice, ref_audio=ref_audio, ref_text=ref_text, **kwargs
                )

        patched_generate._pocket_tts_codec_patched = True  # type: ignore[attr-defined]
        Model.generate = patched_generate
        logger.debug("Applied model.generate() codec-cache patch")
    except (ImportError, AttributeError) as exc:
        logger.warning("Could not apply generate() codec-cache patch: %s", exc)


# ------------------------------------------------------------------
# Backend implementation
# ------------------------------------------------------------------


class FishSpeechBackend:
    """Fish Audio S2 Pro via MLX — ``TTSBackend`` implementation."""

    # ------------------------------------------------------------------
    # Protocol-required attributes
    # ------------------------------------------------------------------

    @property
    def backend_name(self) -> str:
        return "fish-speech"

    @property
    def sample_rate(self) -> int:
        if self._model is None:
            return 44100  # Default for fish-speech; real value comes after load()
        return int(self._model.sample_rate)

    @property
    def supports_tags(self) -> bool:
        return True

    @property
    def predefined_voices(self) -> list[str]:
        # fish-speech has no built-in voice embeddings
        return []

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def __init__(self) -> None:
        self._model: Any = None  # mlx_audio nn.Module — typed as Any to avoid import
        # Codec index cache: WAV content hash → (indices mx.array, prompt_length int)
        self._codec_cache: dict[str, tuple[Any, int]] = {}

    def load(self, *, model_path: str | None = None, **_kwargs: Any) -> None:
        """Load the Fish Audio S2 Pro MLX model.

        Parameters
        ----------
        model_path:
            HuggingFace repo ID or local directory.  Defaults to
            ``FISH_SPEECH_MODEL_PATH`` env var or
            ``mlx-community/fish-audio-s2-pro-8bit``.
        """
        # Apply patches before loading
        _apply_sanitize_patch()
        _apply_generate_patch()

        from mlx_audio.tts.utils import load_model

        resolved_path = model_path or _DEFAULT_MODEL_PATH
        logger.info("Loading fish-speech backend from %s ...", resolved_path)
        self._model = load_model(model_path=resolved_path)
        logger.info(
            "fish-speech backend ready  (sample_rate=%d, model_type=%s)",
            self.sample_rate,
            getattr(self._model, "model_type", "unknown"),
        )

    def unload(self) -> None:
        """Release model and clear MLX cache."""
        logger.info("Unloading fish-speech backend")
        self._codec_cache.clear()
        if self._model is not None:
            del self._model
            self._model = None
        try:
            import mlx.core as mx

            mx.clear_cache()
        except ImportError:
            pass

    # ------------------------------------------------------------------
    # Voice state
    # ------------------------------------------------------------------

    def get_voice_state(
        self, voice_source: str | Path, target_db: float | int = -16.0
    ) -> FishVoiceState:
        """Build voice state from a WAV path or predefined name.

        For fish-speech, "voice state" is simply the ref_audio file path.
        Predefined pocket-tts voice names (e.g. ``"alba"``) return a
        no-clone state since they have no WAV file equivalent.
        """
        source_str = str(voice_source)

        # Predefined pocket-tts voices don't exist as WAV files
        # that fish-speech can use — fall back to default (no clone)
        from pocket_tts.utils.utils import PREDEFINED_VOICES

        if source_str in PREDEFINED_VOICES:
            logger.info(
                "Predefined voice '%s' not usable with fish-speech — using default voice",
                source_str,
            )
            return FishVoiceState()

        # URL voices aren't supported by fish-speech (needs local file)
        if source_str.startswith(("http://", "https://", "hf://")):
            logger.warning(
                "URL voice '%s' not supported by fish-speech — using default voice", source_str
            )
            return FishVoiceState()

        # Local file path
        path = Path(source_str)
        if path.exists():
            # Look up or generate cached Whisper transcript to avoid per-request STT
            from pocket_tts.utils.transcript_cache import get_transcript, transcribe_and_cache

            ref_text = get_transcript(path)
            if ref_text is None:
                logger.info(
                    "No cached transcript for %s — transcribing with Whisper (one-time)...",
                    path.name,
                )
                ref_text = transcribe_and_cache(path)
            return FishVoiceState(
                ref_audio_path=str(path), ref_text=ref_text, target_db=float(target_db)
            )

        logger.warning("Voice file not found: %s — using default voice", path)
        return FishVoiceState(target_db=float(target_db))

    def cached_get_voice_state(
        self, voice_source: str | Path, target_db: float | int = -16.0
    ) -> FishVoiceState:
        """Cached version of ``get_voice_state``.

        Since FishVoiceState is lightweight (just a path), caching is cheap.
        """
        return self._cached_get_voice_state(str(voice_source), target_db)

    @lru_cache(maxsize=4)
    def _cached_get_voice_state(
        self, voice_source_str: str, target_db: float | int
    ) -> FishVoiceState:
        return self.get_voice_state(voice_source_str, target_db)

    # ------------------------------------------------------------------
    # Generation
    # ------------------------------------------------------------------

    def generate_audio_stream(
        self,
        voice_state: Any,
        text: str,
        cancel_event: threading.Event | None = None,
        **kwargs: Any,
    ) -> Iterator[torch.Tensor]:
        """Yield audio chunks as ``torch.Tensor`` (1-D, float32).

        Each yield is one batch/segment worth of audio (segment-level
        streaming).  For short text this may be a single yield; for longer
        text the model splits into sentence batches automatically.

        Pocket-tts ``[Xs]`` pause markers are converted to native fish-speech
        pause tags (``[short pause]``, ``[pause]``, ``[long pause]``) so the
        full text is sent as a single generation call.  This preserves tag
        context across the Dual-AR — emotion transitions stay coherent instead
        of being fragmented into isolated segments.

        Extra ``**kwargs`` are forwarded to generation (e.g. ``temperature``,
        ``top_p``, ``top_k``).
        """
        if self._model is None:
            raise RuntimeError("Backend not loaded — call load() first")

        # Convert [Xs] markers to native pause tags instead of splitting
        converted_text = _convert_pause_markers_to_tags(text).strip()
        if not converted_text:
            return

        yield from self._generate_text_segment(converted_text, voice_state, cancel_event, **kwargs)

    # Disk cache directory for codec indices
    _CODEC_CACHE_DIR = (
        Path.home() / "Library" / "Application Support" / "pocket-tts-electron" / "codec-cache"
    )

    def _encode_and_cache_voice(self, wav_path: str) -> tuple[Any, int]:
        """Encode a WAV file through the DAC codec once, cache the result.

        Cache is two-tier: in-memory dict (fastest) backed by on-disk ``.npz``
        files (survives server restarts).  Both are keyed by SHA-256 of the
        WAV file content.

        Returns ``(indices, prompt_length)`` where ``indices`` is an mx.array
        of shape ``[10, T]`` (codebook indices).
        """
        import hashlib

        import mlx.core as mx

        # Hash file content for cache key
        h = hashlib.sha256()
        with open(wav_path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        cache_key = h.hexdigest()

        # 1. In-memory cache (hot path)
        if cache_key in self._codec_cache:
            logger.debug("Codec cache hit (memory) for %s", Path(wav_path).name)
            return self._codec_cache[cache_key]

        # 2. On-disk cache (warm path — survives server restarts)
        disk_path = self._CODEC_CACHE_DIR / f"{cache_key}.npz"
        if disk_path.exists():
            try:
                data = np.load(str(disk_path))
                codes = mx.array(data["codes"])
                prompt_length = int(data["prompt_length"])
                self._codec_cache[cache_key] = (codes, prompt_length)
                logger.info(
                    "Codec cache hit (disk) for %s: [10, %d]", Path(wav_path).name, codes.shape[1]
                )
                return codes, prompt_length
            except Exception as exc:
                logger.warning("Corrupt codec cache file %s, re-encoding: %s", disk_path, exc)

        # 3. Cache miss — encode through codec and persist
        from mlx_audio.utils import load_audio

        logger.info("Encoding %s through DAC codec (one-time)...", Path(wav_path).name)
        audio = load_audio(wav_path, sample_rate=self._model.sample_rate)

        # Cap reference audio at 30s — voice cloning quality plateaus beyond this,
        # and longer prompts increase KV cache size → slower Dual-AR inference.
        max_samples = 30 * self._model.sample_rate
        if audio.shape[-1] > max_samples:
            logger.info(
                "Trimming ref audio from %.1fs to 30s for codec encoding",
                audio.shape[-1] / self._model.sample_rate,
            )
            audio = audio[..., :max_samples]

        if audio.ndim == 1:
            audio = audio[None, None, :]
        elif audio.ndim == 2:
            audio = audio[None, :, :]
        if audio.shape[1] != 1:
            audio = mx.mean(audio, axis=1, keepdims=True)

        indices, feature_lengths = self._model.codec.encode(audio)
        prompt_length = int(feature_lengths[0].item())
        codes = indices[0]  # shape [10, T]
        mx.eval(codes)

        # Store in memory
        self._codec_cache[cache_key] = (codes, prompt_length)

        # Persist to disk
        try:
            self._CODEC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            np.savez(str(disk_path), codes=np.array(codes), prompt_length=np.array(prompt_length))
            logger.info(
                "Cached codec indices for %s: [10, %d] (%d frames) → %s",
                Path(wav_path).name,
                codes.shape[1],
                prompt_length,
                disk_path.name,
            )
        except OSError as exc:
            logger.warning("Could not persist codec cache to disk: %s", exc)

        return codes, prompt_length

    # Regex to detect fish-speech inline tags like [whisper], [excited], etc.
    # Excludes [Xs] pause markers (handled separately by parse_pause_markers).
    _TAG_RE = re.compile(r"\[[a-zA-Z]")

    def _generate_text_segment(
        self,
        text: str,
        voice_state: Any,
        cancel_event: threading.Event | None = None,
        **kwargs: Any,
    ) -> Iterator[torch.Tensor]:
        """Generate audio for a single text segment."""
        ref_text: str | None = None
        gen_kwargs: dict[str, Any] = {
            "text": text,
            "ref_audio": None,
            "ref_text": None,
            "max_tokens": 2048,
            "temperature": kwargs.get("temperature", 0.7),
            "top_p": kwargs.get("top_p", 0.7),
            "top_k": kwargs.get("top_k", 30),
        }

        if isinstance(voice_state, FishVoiceState) and voice_state.ref_audio_path:
            ref_text = voice_state.ref_text
            gen_kwargs["ref_text"] = ref_text

            # Use cached codec indices if available, otherwise encode and cache
            codes, prompt_length = self._encode_and_cache_voice(voice_state.ref_audio_path)
            gen_kwargs["ref_codes"] = codes
            gen_kwargs["ref_codes_length"] = prompt_length
            # ref_audio stays None — the patched generate() uses ref_codes instead

        # When inline [tags] are present, skip RMS normalization to preserve
        # the model's intended dynamic range (e.g. [whisper] should be quiet,
        # [loud angry shouting] should be loud).  Without tags, normalize to
        # the user's configured target_db for consistent output levels.
        has_tags = bool(self._TAG_RE.search(text))
        target_db = voice_state.target_db if isinstance(voice_state, FishVoiceState) else -16.0

        logger.info("fish-speech generating: %.60s%s", text, "..." if len(text) > 60 else "")

        for result in self._model.generate(**gen_kwargs):
            if cancel_event is not None and cancel_event.is_set():
                logger.info("fish-speech generation cancelled")
                return

            # Convert mx.array → numpy → torch.Tensor
            audio_np = np.array(result.audio, copy=False).astype(np.float32)
            audio_tensor = torch.from_numpy(audio_np)

            if has_tags:
                # Tags present — only clamp to [-1, 1], preserve model dynamics
                peak = audio_tensor.abs().max()
                if peak > 1.0:
                    audio_tensor = audio_tensor / peak
            else:
                # No tags — apply RMS normalization to target level
                audio_tensor = _normalize_audio_rms(audio_tensor, target_db)

            logger.info(
                "fish-speech segment %d: %.1fs audio, RTF=%.2f, peak_mem=%.1f GB%s",
                result.segment_idx,
                float(result.audio.shape[0]) / self.sample_rate,
                result.real_time_factor,
                result.peak_memory_usage,
                "" if has_tags else f", norm={target_db:.0f} dB",
            )

            yield audio_tensor

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    @property
    def default_voice_state(self) -> FishVoiceState:
        """Default (no clone) voice state."""
        return FishVoiceState()

    @property
    def model(self) -> Any:
        """Direct access to the underlying mlx_audio model."""
        return self._model
