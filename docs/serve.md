# Serve Command Documentation

The `serve` command starts a FastAPI web server that provides a web interface, HTTP API, and WebSocket streaming endpoint for text-to-speech generation.

## Basic Usage

```bash
uvx pocket-tts serve
# or if installed manually:
pocket-tts serve
```

This starts a server on `http://localhost:8000` with the default voice model.

## Command Options

- `--voice VOICE`: Path to voice prompt audio file (voice to clone) (default: "hf://kyutai/tts-voices/alba-mackenna/casual.wav")
- `--host HOST`: Host to bind to (default: "localhost")
- `--port PORT`: Port to bind to (default: 8000)
- `--reload`: Enable auto-reload for development

## Examples

### Basic Server

```bash
# Start with default settings
pocket-tts serve

# Custom host and port
pocket-tts serve --host "localhost" --port 8080
```

### Custom Voice

```bash
# Use different voice
pocket-tts serve --voice "hf://kyutai/tts-voices/jessica-jian/casual.wav"

# Use local voice file
pocket-tts serve --voice "./my_voice.wav"
```

## Web Interface

Once the server is running, navigate to `http://localhost:8000` to access the web interface.

## WebSocket Streaming Endpoint

The server provides a `/stream-tts` WebSocket endpoint that accepts streaming text input and plays generated audio directly through the server's speakers. This is ideal for real-time integration with AI assistants, messaging platforms, or any application requiring server-side audio playback.

### Endpoint

```
ws://localhost:8000/stream-tts
```

### Message Protocol

The WebSocket uses JSON messages for bidirectional communication:

**Client → Server:**
```json
{"type": "config", "voice": "alba"}           // Optional: set voice
{"type": "text", "data": "text chunk"}        // Stream text
{"type": "complete"}                          // Signal end
{"type": "cancel"}                            // Cancel playback
```

**Server → Client:**
```json
{"type": "connected", "message": "Ready to receive text"}
{"type": "ready", "message": "Voice configured"}
{"type": "sentence_received", "text": "..."}
{"type": "generating", "sentence_index": 0}
{"type": "playing", "sentence_index": 0}
{"type": "sentence_complete", "sentence_index": 0}
{"type": "finished", "message": "All audio complete"}
{"type": "backpressure", "queue_size": 5, "retry_after_ms": 500}
{"type": "error", "code": "ERROR_CODE", "message": "..."}
```

### Example (Python)

```python
import asyncio
import json
import websockets

async def stream_text_to_tts():
    async with websockets.connect("ws://localhost:8000/stream-tts") as ws:
        # Receive connection acknowledgment
        response = json.loads(await ws.recv())
        print(f"Connected: {response}")

        # Configure voice (optional)
        await ws.send(json.dumps({"type": "config", "voice": "alba"}))
        response = json.loads(await ws.recv())
        print(f"Voice configured: {response}")

        # Stream text
        sentences = [
            "Hello, this is the first sentence.",
            "Here comes the second sentence.",
            "And finally, the third sentence."
        ]

        for sentence in sentences:
            await ws.send(json.dumps({"type": "text", "data": sentence + " "}))
            await asyncio.sleep(0.3)  # Simulate streaming delay

        # Signal completion
        await ws.send(json.dumps({"type": "complete"}))

        # Listen for status updates
        while True:
            response = json.loads(await ws.recv())
            print(f"Status: {response}")
            if response["type"] == "finished":
                break

asyncio.run(stream_text_to_tts())
```

### Features

- **Server-Side Playback**: Audio plays through the server's speakers (not sent back to client)
- **Sentence Buffering**: Text is buffered and processed sentence-by-sentence using `pysbd` for robust sentence detection
- **Progressive Generation**: Sentences are generated and played as soon as they're complete
- **Backpressure Control**: Queue limits prevent memory overflow during rapid text streaming
- **Voice Configuration**: Support for both predefined voices and custom voice cloning via uploaded audio
- **Concurrent Safety**: Generation lock ensures thread-safe TTS model access

### Use Cases

- AI assistant integration (ChatGPT, Claude, etc.)
- Real-time narration for messaging platforms (Signal, Telegram)
- Live captioning with audio feedback
- Interactive voice applications
- Text-to-speech streaming from external services

### Testing

You can test the WebSocket endpoint using the included end-to-end test script:

```bash
# Make sure the server is running first
uv run pocket-tts serve

# In another terminal, run the test
python scripts/test_stream_tts_e2e.py
```

For more advanced usage, see the [Python API documentation](python-api.md) for direct integration with the TTS model.