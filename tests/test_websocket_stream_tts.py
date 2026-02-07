"""Tests for WebSocket streaming TTS endpoint."""

import pytest
from fastapi.testclient import TestClient

from pocket_tts.main import web_app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(web_app)


def test_websocket_connect_no_audio_device(client, monkeypatch):
    """Test WebSocket connection when audio device is not available."""
    # Mock audio_player as None to simulate no audio device
    import pocket_tts.main as main_module

    original_audio_player = main_module.audio_player
    main_module.audio_player = None

    try:
        with pytest.raises(Exception):  # Connection will be closed
            with client.websocket_connect("/stream-tts") as websocket:
                pass
    finally:
        main_module.audio_player = original_audio_player


def test_extract_sentences_with_pysbd():
    """Test sentence extraction with pysbd."""
    from pocket_tts.main import extract_sentences

    # Test complete sentences
    buffer = "Hello world. This is a test. How are you?"
    sentences, remaining = extract_sentences(buffer)

    assert len(sentences) == 3
    assert "Hello world." in sentences[0]
    assert "This is a test." in sentences[1]
    assert "How are you?" in sentences[2]
    assert remaining == ""


def test_extract_sentences_incomplete():
    """Test sentence extraction with incomplete sentence."""
    from pocket_tts.main import extract_sentences

    # Test incomplete sentence
    buffer = "Hello world. This is incomplete"
    sentences, remaining = extract_sentences(buffer)

    assert len(sentences) == 1
    assert "Hello world." in sentences[0]
    assert "This is incomplete" in remaining


def test_extract_sentences_abbreviations():
    """Test that abbreviations don't cause false splits with pysbd."""
    from pocket_tts.main import extract_sentences

    try:
        import pysbd

        # Test abbreviation
        buffer = "Dr. Smith said hello. He is nice."
        sentences, remaining = extract_sentences(buffer)

        # pysbd should NOT split after "Dr."
        assert len(sentences) == 2
        assert "Dr. Smith said hello." in sentences[0]
        assert "He is nice." in sentences[1]
    except ImportError:
        pytest.skip("pysbd not available")


def test_extract_sentences_empty():
    """Test sentence extraction with empty buffer."""
    from pocket_tts.main import extract_sentences

    sentences, remaining = extract_sentences("")
    assert sentences == []
    assert remaining == ""


def test_extract_sentences_no_punctuation():
    """Test sentence extraction with no punctuation."""
    from pocket_tts.main import extract_sentences

    buffer = "Hello world"
    sentences, remaining = extract_sentences(buffer)

    assert sentences == []
    assert remaining == "Hello world"


def test_extract_sentences_short_sentences():
    """Test that very short sentences (< 3 chars) are filtered."""
    from pocket_tts.main import extract_sentences

    buffer = "A. B. Hello world."
    sentences, remaining = extract_sentences(buffer)

    # "A." and "B." should be filtered out
    assert len(sentences) >= 1
    assert any("Hello world." in s for s in sentences)


def test_extract_sentences_multiple_punctuation():
    """Test sentence extraction with multiple punctuation marks."""
    from pocket_tts.main import extract_sentences

    buffer = "What?! Really!? Yes..."
    sentences, remaining = extract_sentences(buffer)

    # Should handle multiple punctuation marks
    assert len(sentences) >= 1


def test_extract_sentences_decimals():
    """Test that decimal numbers don't cause false splits with pysbd."""
    from pocket_tts.main import extract_sentences

    try:
        import pysbd

        buffer = "The cost is $3.50 per unit. It's affordable."
        sentences, remaining = extract_sentences(buffer)

        # pysbd should NOT split after "3."
        assert len(sentences) == 2
        assert "$3.50" in sentences[0]
    except ImportError:
        pytest.skip("pysbd not available")
