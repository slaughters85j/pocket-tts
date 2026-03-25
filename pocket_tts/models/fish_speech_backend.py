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
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import torch

logger = logging.getLogger(__name__)

# Default model — HuggingFace repo ID or local path.
# Override with FISH_SPEECH_MODEL_PATH env var.
_DEFAULT_MODEL_PATH = os.environ.get(
    "FISH_SPEECH_MODEL_PATH", "mlx-community/fish-audio-s2-pro-8bit"
)


# ------------------------------------------------------------------
# Voice state dataclass
# ------------------------------------------------------------------


@dataclass(frozen=True)
class FishVoiceState:
    """Opaque voice state for fish-speech.

    Unlike pocket-tts's heavy dict of hidden-state tensors, fish-speech
    just needs the path to a reference WAV file (or None for default voice).
    """

    ref_audio_path: str | None = None
    ref_text: str | None = None


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

    def load(self, *, model_path: str | None = None, **_kwargs: Any) -> None:
        """Load the Fish Audio S2 Pro MLX model.

        Parameters
        ----------
        model_path:
            HuggingFace repo ID or local directory.  Defaults to
            ``FISH_SPEECH_MODEL_PATH`` env var or
            ``mlx-community/fish-audio-s2-pro-8bit``.
        """
        # Apply sanitize fix before loading
        _apply_sanitize_patch()

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
            return FishVoiceState(ref_audio_path=str(path))

        logger.warning("Voice file not found: %s — using default voice", path)
        return FishVoiceState()

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
        self, voice_state: Any, text: str, cancel_event: threading.Event | None = None
    ) -> Iterator[torch.Tensor]:
        """Yield audio chunks as ``torch.Tensor`` (1-D, float32).

        Each yield is one batch/segment worth of audio (segment-level
        streaming).  For short text this may be a single yield; for longer
        text the model splits into sentence batches automatically.

        Handles pocket-tts ``[Xs]`` pause markers by splitting text into
        segments and inserting silence between them.
        """
        if self._model is None:
            raise RuntimeError("Backend not loaded — call load() first")

        from pocket_tts.text_normalizer import parse_pause_markers

        # Split on [Xs] pause markers first
        segments = parse_pause_markers(text)

        for segment in segments:
            if cancel_event is not None and cancel_event.is_set():
                logger.info("fish-speech generation cancelled")
                return

            # Pause marker → yield silence
            if isinstance(segment, float):
                silence_samples = int(segment * self.sample_rate)
                if silence_samples > 0:
                    logger.info("fish-speech inserting %.1fs silence", segment)
                    yield torch.zeros(silence_samples, dtype=torch.float32)
                continue

            # Text segment → generate audio
            segment_text = segment.strip()
            if not segment_text:
                continue

            yield from self._generate_text_segment(segment_text, voice_state, cancel_event)

    def _generate_text_segment(
        self, text: str, voice_state: Any, cancel_event: threading.Event | None = None
    ) -> Iterator[torch.Tensor]:
        """Generate audio for a single text segment (no pause markers)."""
        import mlx.core as mx

        # Resolve ref_audio to mx.array if voice cloning requested
        ref_audio_mx: mx.array | None = None
        ref_text: str | None = None
        if isinstance(voice_state, FishVoiceState) and voice_state.ref_audio_path:
            from mlx_audio.utils import load_audio

            ref_audio_mx = load_audio(
                voice_state.ref_audio_path, sample_rate=self._model.sample_rate
            )
            ref_text = voice_state.ref_text

        gen_kwargs: dict[str, Any] = {
            "text": text,
            "ref_audio": ref_audio_mx,
            "ref_text": ref_text,
            "max_tokens": 2048,
            "temperature": 0.7,
            "top_p": 0.7,
            "top_k": 30,
        }

        logger.info("fish-speech generating: %.60s%s", text, "..." if len(text) > 60 else "")

        for result in self._model.generate(**gen_kwargs):
            if cancel_event is not None and cancel_event.is_set():
                logger.info("fish-speech generation cancelled")
                return

            # Convert mx.array → numpy → torch.Tensor
            audio_np = np.array(result.audio, copy=False).astype(np.float32)
            audio_tensor = torch.from_numpy(audio_np)

            # Normalise to [-1, 1] range if needed
            peak = audio_tensor.abs().max()
            if peak > 1.0:
                audio_tensor = audio_tensor / peak

            logger.info(
                "fish-speech segment %d: %.1fs audio, RTF=%.2f, peak_mem=%.1f GB",
                result.segment_idx,
                float(result.audio.shape[0]) / self.sample_rate,
                result.real_time_factor,
                result.peak_memory_usage,
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
