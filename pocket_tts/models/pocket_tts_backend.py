"""Pocket-TTS backend — adapter wrapping the existing TTSModel.

This is a thin delegation layer that makes the monolithic ``TTSModel``
conform to the ``TTSBackend`` protocol without modifying it.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Iterator

import torch

from pocket_tts.default_parameters import (
    DEFAULT_EOS_THRESHOLD,
    DEFAULT_VARIANT,
)
from pocket_tts.models.tts_model import TTSModel
from pocket_tts.utils.utils import PREDEFINED_VOICES

logger = logging.getLogger(__name__)


class PocketTTSBackend:
    """Adapter that wraps :class:`TTSModel` to satisfy ``TTSBackend``."""

    # ------------------------------------------------------------------
    # Protocol-required attributes
    # ------------------------------------------------------------------

    @property
    def backend_name(self) -> str:
        return "pocket-tts"

    @property
    def sample_rate(self) -> int:
        if self._model is None:
            return 24000  # Default for pocket-tts; real value comes after load()
        return self._model.sample_rate

    @property
    def supports_tags(self) -> bool:
        return False

    @property
    def predefined_voices(self) -> list[str]:
        return list(PREDEFINED_VOICES.keys())

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def __init__(self) -> None:
        self._model: TTSModel | None = None
        self._default_voice_state: dict | None = None

    def load(
        self,
        *,
        voice: str = "alba",
        variant: str = DEFAULT_VARIANT,
        eos_threshold: float = DEFAULT_EOS_THRESHOLD,
        **_kwargs: Any,
    ) -> None:
        """Load the Kyutai pocket-tts model and pre-warm a default voice."""
        logger.info("Loading pocket-tts backend (variant=%s) ...", variant)
        self._model = TTSModel.load_model(variant, eos_threshold=eos_threshold)
        self._default_voice_state = self._model.get_state_for_audio_prompt(voice)
        logger.info("pocket-tts backend ready  (sample_rate=%d)", self.sample_rate)

    def unload(self) -> None:
        """Release model weights."""
        logger.info("Unloading pocket-tts backend")
        if self._model is not None:
            del self._model
            self._model = None
        self._default_voice_state = None

    # ------------------------------------------------------------------
    # Voice state
    # ------------------------------------------------------------------

    def get_voice_state(
        self,
        voice_source: str | Path,
        target_db: float = -16.0,
    ) -> dict:
        """Build voice state from a predefined name, path, or URL."""
        if self._model is None:
            raise RuntimeError("Backend not loaded — call load() first")
        return self._model.get_state_for_audio_prompt(
            voice_source, truncate=True, target_db=target_db
        )

    def cached_get_voice_state(
        self,
        voice_source: str | Path,
        target_db: float = -16.0,
    ) -> dict:
        """Like ``get_voice_state`` but with LRU caching (maxsize=4)."""
        if self._model is None:
            raise RuntimeError("Backend not loaded — call load() first")
        return self._model._cached_get_state_for_audio_prompt(
            voice_source, truncate=True, target_db=target_db
        )

    def generate_audio_stream(
        self,
        voice_state: Any,
        text: str,
        cancel_event: threading.Event | None = None,
    ) -> Iterator[torch.Tensor]:
        """Yield 80 ms PCM audio chunks at 24 kHz.

        Delegates directly to ``TTSModel.generate_audio_stream``.
        """
        if self._model is None:
            raise RuntimeError("Backend not loaded — call load() first")
        yield from self._model.generate_audio_stream(
            model_state=voice_state,
            text_to_generate=text,
            cancel_event=cancel_event,
        )

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    @property
    def default_voice_state(self) -> dict | None:
        """Pre-loaded default voice state (set during ``load()``)."""
        return self._default_voice_state

    @property
    def model(self) -> TTSModel | None:
        """Direct access to the underlying TTSModel (for multi-talk, etc.)."""
        return self._model
