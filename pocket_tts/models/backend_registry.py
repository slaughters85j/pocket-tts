"""Backend registry — detects available backends and manages the active one.

The :class:`BackendManager` is the single point of contact for the rest of
the application.  It owns the active backend instance, handles load/unload
transitions, and exposes the default voice state.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from pocket_tts.models.backend_protocol import TTSBackend

logger = logging.getLogger(__name__)

# Lock for thread-safe backend switching (the switch itself should not race
# with an in-flight generation request).
_switch_lock = threading.Lock()


# ------------------------------------------------------------------
# Detection
# ------------------------------------------------------------------


def get_available_backends() -> list[str]:
    """Return the list of backend names that can be loaded on this machine.

    ``"pocket-tts"`` is always available.  ``"fish-speech"`` requires
    ``mlx-audio`` and Apple Silicon.
    """
    backends = ["pocket-tts"]
    try:
        import mlx_audio  # noqa: F401

        backends.append("fish-speech")
    except ImportError:
        pass
    return backends


def is_backend_available(name: str) -> bool:
    return name in get_available_backends()


# ------------------------------------------------------------------
# Factory
# ------------------------------------------------------------------


def _create_backend(name: str) -> TTSBackend:
    """Instantiate (but do NOT load) a backend by name."""
    if name == "pocket-tts":
        from pocket_tts.models.pocket_tts_backend import PocketTTSBackend

        return PocketTTSBackend()

    if name == "fish-speech":
        if not is_backend_available("fish-speech"):
            raise RuntimeError(
                "fish-speech backend requires mlx-audio (pip install mlx-audio). "
                "It is only available on Apple Silicon Macs."
            )
        from pocket_tts.models.fish_speech_backend import FishSpeechBackend

        return FishSpeechBackend()

    raise ValueError(f"Unknown backend: {name!r}.  Available: {get_available_backends()}")


# ------------------------------------------------------------------
# Manager
# ------------------------------------------------------------------


class BackendManager:
    """Owns the active TTS backend and coordinates load/unload transitions.

    Attributes
    ----------
    active : TTSBackend
        The currently loaded backend.  Raises ``RuntimeError`` if nothing is
        loaded.
    active_name : str | None
        Name of the active backend (or ``None`` before first load).
    switching : bool
        ``True`` while a backend switch is in progress (callers should
        return 503).
    """

    def __init__(self) -> None:
        self._active: TTSBackend | None = None
        self._active_name: str | None = None
        self._switching = False

    # -- Properties ---------------------------------------------------

    @property
    def active(self) -> TTSBackend:
        if self._active is None:
            raise RuntimeError("No backend loaded — call activate() first")
        return self._active

    @property
    def active_name(self) -> str | None:
        return self._active_name

    @property
    def switching(self) -> bool:
        return self._switching

    @property
    def default_voice_state(self) -> Any:
        """The pre-loaded default voice state of the active backend."""
        return getattr(self._active, "default_voice_state", None)

    # -- Lifecycle ----------------------------------------------------

    def activate(self, backend_name: str, **load_kwargs: Any) -> None:
        """Load a backend, unloading any currently active one first.

        This is the primary entry point for both initial startup and runtime
        switching.

        Parameters
        ----------
        backend_name:
            ``"pocket-tts"`` or ``"fish-speech"``.
        **load_kwargs:
            Forwarded to the backend's ``load()`` method (e.g. ``voice``,
            ``model_path``, ``eos_threshold``).
        """
        with _switch_lock:
            self._switching = True
            try:
                # Unload current backend
                if self._active is not None:
                    logger.info("Deactivating %s backend", self._active_name)
                    self._active.unload()
                    self._active = None
                    self._active_name = None

                # Create and load new backend
                backend = _create_backend(backend_name)
                backend.load(**load_kwargs)
                self._active = backend
                self._active_name = backend_name
                logger.info("Activated %s backend", backend_name)
            finally:
                self._switching = False

    def deactivate(self) -> None:
        """Unload the current backend without loading a replacement."""
        with _switch_lock:
            if self._active is not None:
                self._active.unload()
                self._active = None
                self._active_name = None
