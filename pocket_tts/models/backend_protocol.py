"""TTSBackend protocol — the common interface for all TTS backends.

Every backend (Kyutai pocket-tts, Fish Audio S2 Pro, etc.) must satisfy
this structural typing contract.  We use typing.Protocol so that existing
classes can conform without inheriting a base class.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import torch
from beartype.typing import Iterator


@runtime_checkable
class TTSBackend(Protocol):
    """Structural protocol for pluggable TTS backends.

    Properties
    ----------
    backend_name : str
        Short identifier, e.g. ``"pocket-tts"`` or ``"fish-speech"``.
    sample_rate : int
        Output audio sample rate in Hz (e.g. 24000, 44100).
    supports_tags : bool
        Whether the backend honours inline ``[tag]`` prosody/emotion markers.
    predefined_voices : list[str]
        Names of built-in voices (may be empty).
    """

    @property
    def backend_name(self) -> str: ...

    @property
    def sample_rate(self) -> int: ...

    @property
    def supports_tags(self) -> bool: ...

    @property
    def predefined_voices(self) -> list[str]: ...

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def load(self, **kwargs: Any) -> None:
        """Load model weights into memory. Must be called before generation."""
        ...

    def unload(self) -> None:
        """Release model weights and free memory."""
        ...

    # ------------------------------------------------------------------
    # Voice state
    # ------------------------------------------------------------------

    def get_voice_state(self, voice_source: str | Path, target_db: float | int = -16.0) -> Any:
        """Build a voice-conditioning state from an audio source.

        Parameters
        ----------
        voice_source:
            A predefined voice name, a file path, a URL, or any
            backend-specific identifier.
        target_db:
            RMS loudness normalisation target in dB.

        Returns
        -------
        An opaque state object understood by ``generate_audio_stream``.
        """
        ...

    def cached_get_voice_state(
        self, voice_source: str | Path, target_db: float | int = -16.0
    ) -> Any:
        """Like ``get_voice_state`` but with LRU caching."""
        ...

    # ------------------------------------------------------------------
    # Generation
    # ------------------------------------------------------------------

    def generate_audio_stream(
        self, voice_state: Any, text: str, cancel_event: threading.Event | None = None
    ) -> Iterator[torch.Tensor]:
        """Yield PCM audio chunks as 1-D ``torch.Tensor`` (shape ``[samples]``).

        Chunks are mono, float32, at ``self.sample_rate``.  The caller is
        responsible for writing WAV headers, buffering, and playback.

        Parameters
        ----------
        voice_state:
            Opaque state returned by ``get_voice_state``.
        text:
            Text to synthesise.
        cancel_event:
            Optional threading event — when set the generator should
            stop as soon as practical.
        """
        ...
