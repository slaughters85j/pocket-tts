"""Whisper transcript cache for fish-speech voice cloning.

Transcribes reference WAV files once via Whisper, caches the result to
disk keyed by SHA-256 hash.  Subsequent lookups are instant — Whisper
never runs twice for the same audio file.

Cache location:
    ``~/Library/Application Support/pocket-tts-electron/voice_transcripts.json``
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_CACHE_DIR = Path.home() / "Library" / "Application Support" / "pocket-tts-electron"
_CACHE_FILE = _CACHE_DIR / "voice_transcripts.json"


# ------------------------------------------------------------------
# Hash helper
# ------------------------------------------------------------------


def _sha256_of_file(path: Path) -> str:
    """Return hex SHA-256 digest of a file, reading in 64 KB chunks."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------
# Cache I/O
# ------------------------------------------------------------------


def _load_cache() -> dict:
    if _CACHE_FILE.exists():
        try:
            return json.loads(_CACHE_FILE.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Corrupt transcript cache, starting fresh: %s", exc)
    return {}


def _save_cache(cache: dict) -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _CACHE_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------


def get_transcript(wav_path: str | Path) -> str | None:
    """Look up a cached transcript for a WAV file.

    Returns the transcript string if the cache contains an entry whose
    SHA-256 matches the current file, otherwise ``None``.
    """
    wav_path = Path(wav_path)
    if not wav_path.exists():
        return None

    file_hash = _sha256_of_file(wav_path)
    cache = _load_cache()
    entry = cache.get(file_hash)
    if entry and isinstance(entry.get("transcript"), str):
        logger.debug("Transcript cache hit for %s", wav_path.name)
        return entry["transcript"]
    return None


def store_transcript(wav_path: str | Path, transcript: str) -> None:
    """Store a transcript in the cache, keyed by SHA-256 of the WAV file."""
    wav_path = Path(wav_path)
    file_hash = _sha256_of_file(wav_path)
    cache = _load_cache()
    cache[file_hash] = {
        "transcript": transcript,
        "source_path": str(wav_path),
        "transcribed_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_cache(cache)
    logger.info("Cached transcript for %s (%d chars)", wav_path.name, len(transcript))


def transcribe_and_cache(wav_path: str | Path) -> str:
    """Transcribe a WAV file with Whisper, cache the result, return it.

    Loads ``mlx-community/whisper-large-v3-turbo-asr-fp16`` via mlx_audio,
    runs STT, then immediately frees the model and clears the MLX cache.
    """
    import mlx.core as mx
    from mlx_audio.stt import load as load_stt_model
    from mlx_audio.utils import load_audio

    wav_path = Path(wav_path)
    logger.info("Transcribing %s with Whisper (one-time)...", wav_path.name)

    # Load audio at Whisper's expected sample rate (16 kHz)
    audio = load_audio(str(wav_path), sample_rate=16000)

    # Load Whisper, transcribe, free immediately
    stt_model = load_stt_model("mlx-community/whisper-large-v3-turbo-asr-fp16")
    result = stt_model.generate(audio)
    transcript = result.text.strip()

    del stt_model
    mx.clear_cache()

    logger.info(
        "Whisper transcript (%d chars): %.80s%s",
        len(transcript),
        transcript,
        "..." if len(transcript) > 80 else "",
    )

    store_transcript(wav_path, transcript)
    return transcript
