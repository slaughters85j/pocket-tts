#!/usr/bin/env python3
"""
End-to-end test for WebSocket streaming TTS with server-side audio playback.

This script connects to a running pocket-tts server and streams text via WebSocket,
verifying that audio plays through the server's speakers.

Prerequisites:
    1. Start the server: uv run pocket-tts serve
    2. Run this script: python scripts/test_stream_tts_e2e.py

Expected behavior:
    - Server receives 5 sentences
    - Audio plays through server's speakers
    - Client receives status updates
    - All sentences complete successfully
"""

import asyncio
import json
import sys
import time

try:
    import websockets
except ImportError:
    print("ERROR: websockets library not found")
    print("Install with: uv pip install websockets")
    sys.exit(1)

# Default voice to use for testing
DEFAULT_VOICE = "alba"

# Test sentences
TEST_SENTENCES = [
    "Hello, this is sentence number one.",
    "This is the second sentence being streamed.",
    "Here comes sentence number three.",
    "Fourth sentence is now being generated.",
    "And finally, this is the fifth and last sentence.",
]


async def test_streaming_tts(server_url: str = "ws://localhost:8000/stream-tts"):
    """
    Test streaming text to TTS server with server-side playback.

    Args:
        server_url: WebSocket server URL
    """
    print(f"🔌 Connecting to {server_url}...")

    try:
        async with websockets.connect(server_url) as websocket:
            # Receive connection acknowledgment
            response = json.loads(await websocket.recv())
            print(f"✅ {response['type']}: {response.get('message', '')}")

            if response["type"] != "connected":
                print(f"❌ Expected 'connected', got '{response['type']}'")
                return False

            # Configure voice
            print(f"🎤 Configuring voice: {DEFAULT_VOICE}")
            await websocket.send(json.dumps({"type": "config", "voice": DEFAULT_VOICE}))
            response = json.loads(await websocket.recv())
            if response["type"] == "ready":
                print(f"✅ Voice configured: {response.get('message', '')}")
            else:
                print(f"⚠️  Voice config returned: {response['type']}")

            # Track statistics
            sentences_received = 0
            sentences_generating = 0
            sentences_playing = 0
            sentences_complete = 0
            errors = []
            backpressure_count = 0

            print(f"\n📝 Streaming {len(TEST_SENTENCES)} sentences...")
            print("-" * 60)

            # Stream each sentence with a small delay
            for i, sentence in enumerate(TEST_SENTENCES, 1):
                print(f"📤 Sending sentence {i}: \"{sentence[:50]}...\"")

                await websocket.send(
                    json.dumps({"type": "text", "data": sentence + " "})
                )

                # Small delay between sentences to simulate realistic streaming
                await asyncio.sleep(0.3)

            # Signal completion
            print("\n✓ Signaling completion...")
            await websocket.send(json.dumps({"type": "complete"}))

            # Receive and process all status updates
            print("\n📊 Status updates:")
            print("-" * 60)

            timeout = 120  # 2 minute timeout for all audio to complete
            start_time = time.time()

            while True:
                try:
                    # Wait for next message with timeout
                    response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                    data = json.loads(response)

                    msg_type = data["type"]

                    # Track statistics
                    if msg_type == "sentence_received":
                        sentences_received += 1
                        text_preview = data["text"][:60]
                        print(f"  📥 Sentence received: \"{text_preview}...\"")

                    elif msg_type == "generating":
                        sentences_generating += 1
                        idx = data.get("sentence_index", "?")
                        print(f"  ⚙️  Generating audio for sentence {idx}...")

                    elif msg_type == "playing":
                        sentences_playing += 1
                        idx = data.get("sentence_index", "?")
                        print(f"  🔊 Playing sentence {idx} (listen to speakers!)")

                    elif msg_type == "sentence_complete":
                        sentences_complete += 1
                        idx = data.get("sentence_index", "?")
                        print(f"  ✅ Sentence {idx} complete")

                    elif msg_type == "backpressure":
                        backpressure_count += 1
                        queue_size = data.get("queue_size", "?")
                        print(
                            f"  ⚠️  Backpressure: queue_size={queue_size} (pausing...)"
                        )
                        await asyncio.sleep(0.5)

                    elif msg_type == "error":
                        code = data.get("code", "UNKNOWN")
                        message = data.get("message", "No message")
                        errors.append(f"{code}: {message}")
                        print(f"  ❌ Error: {code} - {message}")

                    elif msg_type == "finished":
                        print(f"\n✅ {msg_type}: {data.get('message', '')}")
                        break

                    else:
                        print(f"  ℹ️  {msg_type}: {data}")

                    # Check timeout
                    if time.time() - start_time > timeout:
                        print(f"\n❌ Timeout after {timeout}s")
                        return False

                except asyncio.TimeoutError:
                    print("\n⏱️  No message received for 5s, assuming completion...")
                    break

            # Print summary
            print("\n" + "=" * 60)
            print("📈 TEST SUMMARY")
            print("=" * 60)
            print(f"Sentences sent:       {len(TEST_SENTENCES)}")
            print(f"Sentences received:   {sentences_received}")
            print(f"Sentences generating: {sentences_generating}")
            print(f"Sentences playing:    {sentences_playing}")
            print(f"Sentences complete:   {sentences_complete}")
            print(f"Backpressure events:  {backpressure_count}")
            print(f"Errors:               {len(errors)}")

            if errors:
                print("\nErrors encountered:")
                for error in errors:
                    print(f"  - {error}")

            # Verify success
            success = (
                sentences_received == len(TEST_SENTENCES)
                and sentences_complete == len(TEST_SENTENCES)
                and len(errors) == 0
            )

            print("\n" + "=" * 60)
            if success:
                print("✅ TEST PASSED - All sentences processed successfully!")
                print("   (Did you hear the audio through your speakers?)")
            else:
                print("❌ TEST FAILED - Some issues detected")
                print(f"   Expected {len(TEST_SENTENCES)} sentences complete, got {sentences_complete}")

            print("=" * 60)

            return success

    except websockets.exceptions.WebSocketException as e:
        print(f"\n❌ WebSocket error: {e}")
        print("\nIs the server running?")
        print("Start with: uv run pocket-tts serve")
        return False

    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback

        traceback.print_exc()
        return False


async def test_voice_configuration(server_url: str = "ws://localhost:8000/stream-tts"):
    """Test configuring a different voice."""
    print("\n\n" + "=" * 60)
    print("🎤 TESTING VOICE CONFIGURATION")
    print("=" * 60)

    try:
        async with websockets.connect(server_url) as websocket:
            # Connection
            response = json.loads(await websocket.recv())
            print(f"✅ {response['type']}")

            # Configure a different voice (marius) to test voice switching
            print("🎤 Configuring voice: marius")
            await websocket.send(json.dumps({"type": "config", "voice": "marius"}))

            response = json.loads(await websocket.recv())
            if response["type"] == "ready":
                print(f"✅ Voice configured: {response.get('message', '')}")
            else:
                print(f"❌ Voice config failed: {response}")
                return False

            # Send one sentence with the marius voice
            test_text = "This sentence uses the Marius voice."
            print(f"\n📤 Sending: \"{test_text}\"")
            await websocket.send(json.dumps({"type": "text", "data": test_text}))
            await websocket.send(json.dumps({"type": "complete"}))

            # Wait for completion
            while True:
                response = json.loads(await websocket.recv())
                print(f"  {response['type']}")
                if response["type"] == "finished":
                    break

            print("✅ Voice test completed")
            return True

    except Exception as e:
        print(f"❌ Voice test failed: {e}")
        return False


async def main():
    """Run all end-to-end tests."""
    print("=" * 60)
    print("🧪 POCKET-TTS STREAMING E2E TESTS")
    print("=" * 60)
    print("\nThis test will play audio through your server's speakers!")
    print("Make sure your server is running: uv run pocket-tts serve")
    print("\nPress Ctrl+C to cancel, or wait 3 seconds to continue...")

    try:
        await asyncio.sleep(3)
    except KeyboardInterrupt:
        print("\n\n❌ Test cancelled by user")
        return

    # Test 1: Basic streaming
    success1 = await test_streaming_tts()

    # Test 2: Voice configuration
    success2 = await test_voice_configuration()

    # Final summary
    print("\n\n" + "=" * 60)
    print("🏁 FINAL RESULTS")
    print("=" * 60)
    print(f"Basic streaming test: {'✅ PASS' if success1 else '❌ FAIL'}")
    print(f"Voice config test:    {'✅ PASS' if success2 else '❌ FAIL'}")
    print("=" * 60)

    if success1 and success2:
        print("\n🎉 All tests passed!")
        sys.exit(0)
    else:
        print("\n❌ Some tests failed")
        sys.exit(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n❌ Tests interrupted by user")
        sys.exit(1)
