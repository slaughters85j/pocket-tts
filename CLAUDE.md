# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** This repo gitignores CLAUDE.md. The upstream convention is `ln -s AGENTS.md CLAUDE.md`. This file is a local-only guide.

## Project Overview

Pocket TTS is Kyutai's CPU-based text-to-speech system (~100M params). It uses a flow-based language model (CaLM) with the Mimi neural audio codec for streaming speech synthesis. English only. The project has three frontends: Python CLI/library, Electron desktop app, and macOS native Quick Action.

## Common Commands

```bash
# Setup
uvx pre-commit install

# Run all tests (3 parallel workers)
uv run pytest -n 3 -v

# Run a single test file
uv run pytest tests/test_cli_generate.py -v

# Run a single test by name
uv run pytest tests/test_cli_generate.py -k "test_name" -v

# CLI (editable install via uv)
uv run pocket-tts generate
uv run pocket-tts generate --voice alba --text "Hello world"
uv run pocket-tts serve              # starts FastAPI on :8000
uv run pocket-tts serve --port 8765  # used by macOS Quick Action

# Pre-commit (lint + format)
uvx pre-commit run --all-files

# Electron desktop app
cd electron && npm install && npm run dev
cd electron && npm run build:electron         # build distributable
cd electron && npm run build:dist             # bundle Python + build

# macOS service development
cd macos-service/scripts && ./dev-test.sh     # kills old, builds, installs, opens Xcode
```

## Linting & Formatting

Ruff handles everything via pre-commit. Key settings in `pyproject.toml`:
- Line length: 100
- Line endings: LF
- `skip-magic-trailing-comma = true`
- Relative imports banned (`ban-relative-imports = "all"`)

## CI

GitHub Actions runs on push to `main` and all PRs:
1. `pre-commit` check (ruff-check, ruff-format, import sorting, uv-lock)
2. `pytest` on Python 3.10 and 3.14

## Architecture

### TTS Pipeline (two parallel threads at runtime)

```
Text → SentencePiece tokenizer → LUTConditioner (embeddings)
                                       ↓
Audio prompt → Mimi encoder → voice state → FlowLMModel (CaLM transformer) → latent frames
                                                                                    ↓
                                                                           Mimi decoder → PCM audio
```

Thread 1: CaLM generates latent frames autoregressively (12.5 Hz, 80ms/frame).
Thread 2: Mimi decoder converts latents to waveform in parallel.

### Core Python Package (`pocket_tts/`)

- **`models/tts_model.py`** — `TTSModel`: the only public API class. Orchestrates load, voice encoding, streaming generation. Voice states are LRU-cached.
- **`models/flow_lm.py`** — `FlowLMModel`: transformer that generates latent audio codes from text via Lagrangian Self Distillation (LSD).
- **`modules/`** — `StreamingTransformer`, `StreamingMultiheadAttention` (RoPE), `StatefulModule` base class for KV cache / streaming state.
- **`conditioners/text.py`** — `LUTConditioner`: SentencePiece + embedding lookup.
- **`main.py`** — Typer CLI (`generate`, `serve`) + FastAPI server + web UI.
- **`text_normalizer.py`** — Text preprocessing (numbers, abbreviations, etc.).
- **`config/b6369a24.yaml`** — Model architecture config.

### Electron App (`electron/`)

React + TypeScript + Vite + Tailwind. Electron main process manages a bundled Python server (PyInstaller). Key files:
- `src/main/python-server.ts` — spawns/manages the Python TTS server subprocess
- `src/main/ipc-handlers.ts` — Electron IPC bridge
- `src/renderer/App.tsx` — main UI (single voice, multi-talk, history modes)
- `src/renderer/lib/streaming-wav-player.ts` — progressive WAV playback

### macOS Service (`macos-service/`)

Python streaming script + Swift menu bar app + shell scripts:
- **pocket-tts-stream.py** — Python script invoked by Automator workflow. Sends text to `/tts` endpoint, streams audio via ffplay for real-time playback. Includes diagnostic logging.
- **PocketTTSMenuBar** — Swift menu bar app for voice selection and server monitoring. Uses AppKit lifecycle (not SwiftUI App — fixes menu not appearing).
- **PocketTTSQuickAction** — Legacy Swift CLI (deprecated, kept for reference). Replaced by Python script for better streaming and logging.
- **LaunchAgent** — `com.kyutai.pocket-tts.server.plist` auto-starts the TTS server on login (port 8765).
- Shared config dir: `~/Library/Application Support/pocket-tts-electron/`
- Logs: `~/Library/Logs/PocketTTS/tts-stream-YYYY-MM-DD.log`

**Dependencies:** The Quick Action requires `ffplay` (from ffmpeg) and `uv` for Python dependency management.

**Swift build warning:** Do NOT use bare `swift build` or `xcodebuild` if miniforge/conda is on PATH — it contaminates the linker. Use `xcode-builder-agent` or the `xcodebuild-clean` wrapper.

## Key Implementation Details

- **NOT thread-safe.** Server does not support concurrent requests.
- **Batch size always 1.** No batching support.
- **CPU-only PyTorch** — uses `download.pytorch.org/whl/cpu` index. GPU provides no speedup for this model size.
- **`torch.set_num_threads(1)`** set in `tts_model.py` for optimal CPU perf.
- **Beartype** runtime type checking enabled package-wide in `__init__.py`.
- **EOS detection**: model predicts end-of-speech via EOS head; generation continues `frames_after_eos` frames after detection.
- **Test conftest** sets `POCKET_TTS_ERROR_WITHOUT_EOS=1` so tests fail if EOS is never predicted.
- **Voice cloning** requires gated HF model access (`hf auth login`). Predefined voices work without auth.
- **Model weights** auto-download from HuggingFace Hub on first use and cache locally.

## Gotchas

- PyTorch < 2.5 produces incorrect audio. The `pyproject.toml` enforces `>=2.5.0`.
- Python 3.10–3.14 only. `uv` `python-preference = "only-managed"` because system Python may lack headers.
- Electron: if Electron won't load, check that `ELECTRON_RUN_AS_NODE` env var is not set.
- Editable install: Python source changes take effect immediately for `uv run` and LaunchAgent. New deps require `uv pip install -e .` from project root.
- Electron distributable bundles PyInstaller output, not source — must re-bundle after changes (`electron/python/bundle-python.sh`).
