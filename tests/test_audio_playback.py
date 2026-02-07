"""Tests for server-side audio playback."""

import pytest
import torch

from pocket_tts.audio_playback import PlaybackConfig, ServerAudioPlayer


def test_playback_config_defaults():
    """Test default playback configuration."""
    config = PlaybackConfig()
    assert config.sample_rate == 24000
    assert config.channels == 1
    assert config.dtype == "int16"
    assert config.blocksize == 4096
    assert config.device is None


def test_playback_config_custom():
    """Test custom playback configuration."""
    config = PlaybackConfig(sample_rate=48000, channels=2, dtype="float32", device=1)
    assert config.sample_rate == 48000
    assert config.channels == 2
    assert config.dtype == "float32"
    assert config.device == 1


def test_audio_player_initialization():
    """Test audio player can be initialized."""
    config = PlaybackConfig()

    # This might fail on CI without audio device
    try:
        player = ServerAudioPlayer(config)
        assert player is not None
        assert player.queue_size == 0
        assert not player.is_playing
    except RuntimeError as e:
        pytest.skip(f"No audio device available: {e}")


def test_audio_player_start_stop():
    """Test starting and stopping playback thread."""
    config = PlaybackConfig()

    try:
        player = ServerAudioPlayer(config)
        player.start()
        assert player._playback_thread is not None
        assert player._playback_thread.is_alive()

        player.stop()
        assert player._playback_thread is None
    except RuntimeError:
        pytest.skip("No audio device available")


def test_enqueue_audio():
    """Test enqueueing audio for playback."""
    config = PlaybackConfig()

    try:
        player = ServerAudioPlayer(config)
        # Don't start to avoid actually playing audio
        # player.start()

        # Generate dummy audio chunks
        def dummy_chunks():
            for _ in range(3):
                yield torch.randn(4800)  # 200ms at 24kHz

        session_id = player.enqueue_audio(dummy_chunks())
        assert isinstance(session_id, str)
        assert player.queue_size == 1

        # player.stop()
    except RuntimeError:
        pytest.skip("No audio device available")


def test_cancel_session():
    """Test cancelling a specific session."""
    config = PlaybackConfig()

    try:
        player = ServerAudioPlayer(config)
        # Don't start to avoid actually playing audio
        # player.start()

        def dummy_chunks():
            for _ in range(3):
                yield torch.randn(4800)

        session_id = player.enqueue_audio(dummy_chunks())
        assert session_id in player._session_audio

        player.cancel_session(session_id)
        assert not player._session_audio.get(session_id, False)

        # player.stop()
    except RuntimeError:
        pytest.skip("No audio device available")


def test_clear_queue():
    """Test clearing the playback queue."""
    config = PlaybackConfig()

    try:
        player = ServerAudioPlayer(config)
        # Don't start to avoid actually playing audio
        # player.start()

        def dummy_chunks():
            for _ in range(3):
                yield torch.randn(4800)

        # Enqueue multiple items
        for _ in range(3):
            player.enqueue_audio(dummy_chunks())

        assert player.queue_size == 3

        player.clear_queue()
        assert player.queue_size == 0

        # player.stop()
    except RuntimeError:
        pytest.skip("No audio device available")


def test_queue_full_error():
    """Test that enqueueing fails when queue is full."""
    import queue

    config = PlaybackConfig()

    try:
        player = ServerAudioPlayer(config)
        # Don't start the player so items stay in queue
        # player.start()

        def dummy_chunks():
            for _ in range(10):
                yield torch.randn(24000)  # 1 second

        # Fill queue to max (5 items)
        for _ in range(5):
            player.enqueue_audio(dummy_chunks())

        # Verify queue is full
        assert player.queue_size == 5

        # Next enqueue should fail
        with pytest.raises(queue.Full):
            player.enqueue_audio(dummy_chunks())

        # Cleanup (no need to stop since we never started)
    except RuntimeError:
        pytest.skip("No audio device available")
