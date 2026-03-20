#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""
Send text to pocket-tts HTTP endpoint for server-side playback.
Usage: uv run pocket-tts-stream.py "Text to speak" [voice_path] [--debug]

Pocket TTS API (v2): POST /tts with multipart form data, returns streaming WAV.
Uses ffplay for real-time streaming playback (plays while downloading).
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

POCKET_TTS_URL = "http://localhost:8765/tts"
APP_SUPPORT_DIR = Path.home() / "Library/Application Support/pocket-tts-electron"
CONFIG_FILE = APP_SUPPORT_DIR / "config.json"
VOICES_FILE = APP_SUPPORT_DIR / "voices.json"
VOICES_DIR = APP_SUPPORT_DIR / "voices"
# Predefined voices built into the server (no file needed)
PREDEFINED_VOICES = ["alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma"]
# Fallback voice (Alba - built-in)
DEFAULT_VOICE = "alba"
LOG_DIR = Path.home() / "Library/Logs/PocketTTS"


def get_configured_voice() -> tuple[str, str]:
    """
    Read the selected voice from MenuBar config.
    Returns (voice_type, voice_value) where:
      - ("predefined", "alba") means use predefined voice name
      - ("custom", "/path/to/voice.wav") means use custom voice file
    """
    try:
        # Read config
        if not CONFIG_FILE.exists():
            return ("predefined", DEFAULT_VOICE)
        
        with open(CONFIG_FILE) as f:
            config = json.load(f)
        
        voice_id = config.get("selectedVoiceId")
        voice_type = config.get("selectedVoiceType", "predefined")
        
        if not voice_id:
            return ("predefined", DEFAULT_VOICE)
        
        # For predefined voices, just return the voice name
        if voice_type == "predefined":
            if voice_id in PREDEFINED_VOICES:
                return ("predefined", voice_id)
            # Unknown predefined voice, fallback
            return ("predefined", DEFAULT_VOICE)
        
        # For custom voices, look up file path in voices.json
        if voice_type == "custom" and VOICES_FILE.exists():
            with open(VOICES_FILE) as f:
                voices_data = json.load(f)
            
            for voice in voices_data.get("voices", []):
                if voice.get("id") == voice_id:
                    file_path = voice.get("filePath")
                    if file_path and os.path.exists(file_path):
                        return ("custom", file_path)
        
        # Fallback to default
        return ("predefined", DEFAULT_VOICE)
    
    except Exception as e:
        # On any error, fall back to Alba
        return ("predefined", DEFAULT_VOICE)

# Set up logging
LOG_DIR.mkdir(parents=True, exist_ok=True)
log_file = LOG_DIR / f"tts-stream-{datetime.now().strftime('%Y-%m-%d')}.log"

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler(sys.stderr)
    ]
)
logger = logging.getLogger("pocket-tts-stream")


def restart_pocket_tts():
    """Restart the pocket-tts service."""
    logger.warning("Restarting pocket-tts service...")
    subprocess.run(["launchctl", "stop", "com.kyutai.pocket-tts.server"], capture_output=True)
    time.sleep(2)
    subprocess.run(["launchctl", "start", "com.kyutai.pocket-tts.server"], capture_output=True)
    time.sleep(3)
    logger.info("Service restart complete")


def stream_and_play(text: str, voice_type: str = "predefined", voice_value: str = DEFAULT_VOICE, retry: bool = True) -> bool:
    """
    Stream text to pocket-tts and play the audio response.
    
    Args:
        text: Text to speak
        voice_type: "predefined" or "custom"
        voice_value: Voice name (for predefined) or file path (for custom)
        retry: Whether to retry on connection error
    """
    session_id = datetime.now().strftime('%H%M%S%f')[:10]
    text_preview = text[:80] + "..." if len(text) > 80 else text

    logger.info(f"[{session_id}] === NEW TTS SESSION ===")
    logger.info(f"[{session_id}] Text length: {len(text)} chars")
    logger.info(f"[{session_id}] Preview: {text_preview!r}")
    logger.debug(f"[{session_id}] Voice type: {voice_type}, value: {voice_value}")

    start_time = time.monotonic()
    bytes_received = 0
    chunks_received = 0

    try:
        # Prepare multipart form data
        files = {"text": (None, text)}
        
        if voice_type == "predefined":
            # Pass predefined voice name via voice_url parameter
            files["voice_url"] = (None, voice_value)
            logger.debug(f"[{session_id}] Using predefined voice: {voice_value}")
        elif voice_type == "custom" and voice_value and os.path.exists(voice_value):
            # Upload custom voice file
            voice_size = os.path.getsize(voice_value)
            logger.debug(f"[{session_id}] Loading custom voice file ({voice_size/1024:.1f}KB)...")
            files["voice_wav"] = ("voice.wav", open(voice_value, "rb"), "audio/wav")
        
        logger.info(f"[{session_id}] Sending request to {POCKET_TTS_URL}...")
        
        # Stream the response
        response = requests.post(POCKET_TTS_URL, files=files, stream=True, timeout=60)
        
        request_time = time.monotonic()
        logger.info(f"[{session_id}] Response status: {response.status_code} ({(request_time - start_time)*1000:.0f}ms)")
        
        if response.status_code != 200:
            logger.error(f"[{session_id}] HTTP error: {response.status_code} - {response.text[:200]}")
            return False
        
        # Stream directly to ffplay for real-time playback
        logger.info(f"[{session_id}] Starting streaming playback...")
        
        # Start ffplay reading from stdin
        ffplay_proc = subprocess.Popen(
            ["/opt/homebrew/bin/ffplay", "-nodisp", "-autoexit", "-i", "pipe:0"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        
        first_chunk_time = None
        last_chunk_time = time.monotonic()
        
        try:
            for chunk in response.iter_content(chunk_size=4096):
                if chunk:
                    now = time.monotonic()
                    chunks_received += 1
                    bytes_received += len(chunk)
                    chunk_gap = (now - last_chunk_time) * 1000
                    last_chunk_time = now
                    
                    if first_chunk_time is None:
                        first_chunk_time = now
                        latency = (first_chunk_time - start_time) * 1000
                        logger.info(f"[{session_id}] First chunk received, latency: {latency:.0f}ms")
                    
                    # Write chunk to ffplay
                    ffplay_proc.stdin.write(chunk)
                    
                    if chunks_received % 50 == 0:
                        logger.debug(f"[{session_id}] Chunk {chunks_received}: {bytes_received/1024:.1f}KB total (+{chunk_gap:.0f}ms)")
            
            # Close stdin to signal end of stream
            ffplay_proc.stdin.close()
            
            download_time = time.monotonic()
            logger.info(f"[{session_id}] Stream complete: {bytes_received/1024:.1f}KB in {chunks_received} chunks ({(download_time - request_time):.2f}s)")
            
            # Wait for playback to finish
            ffplay_proc.wait()
            
        except BrokenPipeError:
            logger.error(f"[{session_id}] ffplay pipe broken - player may have crashed")
            return False
        except Exception as e:
            logger.error(f"[{session_id}] Streaming error: {e}")
            ffplay_proc.kill()
            return False
        
        total_time = time.monotonic() - start_time
        logger.info(f"[{session_id}] === FINISHED === Total time: {total_time:.2f}s")
        return True

    except requests.exceptions.ConnectionError as e:
        logger.error(f"[{session_id}] Connection error: {e}")
        if retry:
            restart_pocket_tts()
            return stream_and_play(text, voice_type, voice_value, retry=False)
        return False
    except requests.exceptions.Timeout:
        logger.error(f"[{session_id}] Request timeout after 60s")
        return False
    except Exception as e:
        elapsed = time.monotonic() - start_time
        logger.error(f"[{session_id}] EXCEPTION after {elapsed:.2f}s: {type(e).__name__}: {e}")
        logger.error(f"[{session_id}] State: received {bytes_received} bytes in {chunks_received} chunks")
        return False
    finally:
        # Close voice file if opened
        if "voice_wav" in files and hasattr(files["voice_wav"][1], "close"):
            files["voice_wav"][1].close()


def main():
    parser = argparse.ArgumentParser(description="Stream text to pocket-tts for playback")
    parser.add_argument("text", help="Text to speak")
    parser.add_argument("voice_path", nargs="?", default=None, help="Path to custom voice file (default: use MenuBar selection)")
    parser.add_argument("--debug", "-d", action="store_true", help="Enable verbose console output")
    parser.add_argument("--quiet", "-q", action="store_true", help="Suppress console output (log to file only)")
    args = parser.parse_args()

    # Adjust console log level
    if args.quiet:
        logging.getLogger().handlers[1].setLevel(logging.CRITICAL)
    elif not args.debug:
        logging.getLogger().handlers[1].setLevel(logging.WARNING)

    # Get voice: use CLI arg if provided (as custom voice), otherwise read from MenuBar config
    if args.voice_path:
        voice_type, voice_value = "custom", args.voice_path
    else:
        voice_type, voice_value = get_configured_voice()
    
    logger.info(f"Log file: {log_file}")
    logger.debug(f"Using voice: {voice_type}={voice_value}")
    success = stream_and_play(args.text, voice_type, voice_value, retry=True)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
