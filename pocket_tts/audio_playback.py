"""
Server-side audio playback for streaming TTS.

This module provides server-side audio playback capabilities for the WebSocket
streaming endpoint. Audio is played directly through the server's speakers using
the sounddevice library.
"""

import logging
import queue
import threading
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass

import numpy as np
import sounddevice as sd
import torch

logger = logging.getLogger(__name__)

# Maximum number of audio streams that can be queued
MAX_QUEUE_SIZE = 5


@dataclass
class PlaybackConfig:
    """Configuration for audio playback."""

    sample_rate: int = 24000
    channels: int = 1
    dtype: str = "int16"
    blocksize: int = 4096  # ~170ms at 24kHz
    device: int | None = None  # None = default device


class ServerAudioPlayer:
    """
    Server-side audio player for streaming TTS output.

    Plays audio chunks directly to server speakers. Audio streams are queued
    and played sequentially to maintain natural speech flow.

    Thread-safety: This class uses threading internally but is safe to call
    from async code (e.g., FastAPI WebSocket handlers).
    """

    def __init__(self, config: PlaybackConfig):
        """
        Initialize audio player.

        Args:
            config: Playback configuration

        Raises:
            RuntimeError: If no audio output device is available
        """
        self.config = config
        self._playback_queue: queue.Queue = queue.Queue()
        self._is_playing = False
        self._stop_event = threading.Event()
        self._playback_thread: threading.Thread | None = None
        self._session_audio: dict[str, bool] = {}  # Track active sessions

        # Verify audio device is available
        try:
            devices = sd.query_devices()
            logger.info(f"Available audio devices: {len(devices)} found")

            default_device = sd.query_devices(kind="output")
            logger.info(f"Using output device: {default_device['name']}")
        except Exception as e:
            logger.error(f"Audio device error: {e}")
            raise RuntimeError("No audio output device available") from e

    def start(self):
        """Start the playback worker thread."""
        if self._playback_thread is not None:
            return

        self._stop_event.clear()
        self._playback_thread = threading.Thread(
            target=self._playback_worker, daemon=True, name="AudioPlaybackWorker"
        )
        self._playback_thread.start()
        logger.info("Audio playback thread started")

    def stop(self):
        """Stop the playback worker thread."""
        if self._playback_thread is None:
            return

        self._stop_event.set()
        self._playback_queue.put(None)  # Sentinel to unblock queue
        self._playback_thread.join(timeout=5.0)
        self._playback_thread = None
        logger.info("Audio playback thread stopped")

    def enqueue_audio(
        self,
        audio_chunks: Iterable[torch.Tensor],
        session_id: str | None = None,
        on_start: Callable[[], None] | None = None,
        on_complete: Callable[[], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
    ) -> str:
        """
        Enqueue audio chunks for playback.

        Args:
            audio_chunks: Iterable of audio tensors (shape: [samples])
            session_id: Optional session ID for tracking (generated if not provided)
            on_start: Callback when playback starts
            on_complete: Callback when playback completes successfully
            on_error: Callback on playback error (receives exception)

        Returns:
            Session ID for this audio stream

        Raises:
            queue.Full: If playback queue is at max capacity
        """
        if session_id is None:
            session_id = str(uuid.uuid4())

        # Check queue depth for backpressure
        if self._playback_queue.qsize() >= MAX_QUEUE_SIZE:
            raise queue.Full(f"Playback queue full (max {MAX_QUEUE_SIZE})")

        playback_item = {
            "session_id": session_id,
            "audio_chunks": audio_chunks,
            "on_start": on_start,
            "on_complete": on_complete,
            "on_error": on_error,
        }

        self._session_audio[session_id] = True
        self._playback_queue.put(playback_item)
        logger.debug(
            f"Audio enqueued for session {session_id}, queue size: {self._playback_queue.qsize()}"
        )

        return session_id

    def cancel_session(self, session_id: str):
        """
        Cancel audio for a specific session.

        Args:
            session_id: Session ID to cancel

        Note:
            This marks the session as cancelled. If the audio is currently playing,
            it will continue to completion. Queued audio for this session will be
            skipped when dequeued.
        """
        if session_id in self._session_audio:
            self._session_audio[session_id] = False
            logger.info(f"Session {session_id} audio cancelled")

    def clear_queue(self):
        """Clear all pending audio from queue."""
        while not self._playback_queue.empty():
            try:
                item = self._playback_queue.get_nowait()
                if item and "session_id" in item:
                    self._session_audio.pop(item["session_id"], None)
            except queue.Empty:
                break
        logger.info("Playback queue cleared")

    @property
    def is_playing(self) -> bool:
        """Check if audio is currently playing."""
        return self._is_playing

    @property
    def queue_size(self) -> int:
        """Get number of pending audio streams."""
        return self._playback_queue.qsize()

    def _playback_worker(self):
        """Worker thread that plays audio from queue."""
        while not self._stop_event.is_set():
            try:
                # Wait for next playback item
                item = self._playback_queue.get(timeout=1.0)

                if item is None:  # Sentinel value
                    continue

                session_id = item["session_id"]

                # Check if session was cancelled (default to True if not found)
                if not self._session_audio.get(session_id, True):
                    logger.info(f"Skipping cancelled session {session_id}")
                    continue

                self._play_audio_stream(
                    session_id,
                    item["audio_chunks"],
                    item.get("on_start"),
                    item.get("on_complete"),
                    item.get("on_error"),
                )

                # Note: Don't remove session here - it's shared across multiple
                # sentences. Cleanup happens on explicit cancel or connection close.

            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Playback worker error: {e}", exc_info=True)

    def _play_audio_stream(
        self,
        session_id: str,
        audio_chunks: Iterable[torch.Tensor],
        on_start: Callable[[], None] | None,
        on_complete: Callable[[], None] | None,
        on_error: Callable[[Exception], None] | None,
    ):
        """
        Play audio stream to speakers.

        Args:
            session_id: Session ID for this audio
            audio_chunks: Iterable of audio tensors
            on_start: Callback when playback starts
            on_complete: Callback when playback completes
            on_error: Callback on error
        """
        try:
            # Open audio stream
            with sd.OutputStream(
                samplerate=self.config.sample_rate,
                channels=self.config.channels,
                dtype=self.config.dtype,
                blocksize=self.config.blocksize,
                device=self.config.device,
            ) as stream:

                if on_start:
                    on_start()

                self._is_playing = True
                logger.debug(f"Started playback for session {session_id}")

                # Stream audio chunks
                for chunk in audio_chunks:
                    # Check if stopped or session cancelled
                    if self._stop_event.is_set() or not self._session_audio.get(
                        session_id, False
                    ):
                        logger.info(f"Playback interrupted for session {session_id}")
                        break

                    # Convert float32 [-1, 1] to int16
                    audio_np = chunk.cpu().numpy()
                    audio_int16 = np.clip(audio_np * 32767, -32768, 32767).astype(
                        np.int16
                    )

                    # Reshape for mono: (samples, 1)
                    if audio_int16.ndim == 1:
                        audio_int16 = audio_int16.reshape(-1, 1)

                    # Write to stream (blocks until played)
                    stream.write(audio_int16)

                self._is_playing = False
                logger.debug(f"Completed playback for session {session_id}")

                if on_complete:
                    on_complete()

        except Exception as e:
            logger.error(f"Audio playback error for session {session_id}: {e}", exc_info=True)
            self._is_playing = False
            if on_error:
                on_error(e)
