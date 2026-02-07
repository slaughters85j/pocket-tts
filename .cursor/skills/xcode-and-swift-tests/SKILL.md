---
name: xcode-and-swift-tests
description: Mandatory build and test rules for macos-service Swift/Xcode projects. Use for any edit, build, or test in macos-service/, PocketTTSMenuBar, PocketTTSQuickAction, or when the user mentions Xcode, Swift build, swift build, xcodebuild, or writing Swift tests. Overrides README or other docs that suggest bare swift build or xcodebuild.
---

# Xcode and Swift Tests (macos-service)

**This skill applies whenever you touch Swift/Xcode code in this repo.** Follow these rules every time; do not suggest or run `swift build` or bare `xcodebuild`.

---

## Build rules (mandatory)

### Never do

- **Do not run** `swift build` (any variant).
- **Do not run** bare `xcodebuild` (e.g. `xcodebuild -scheme PocketTTSMenuBar build`).
- **Do not** suggest opening Terminal and running `swift build` or `xcodebuild` from the project root or from `macos-service/`.

Reason: the environment (e.g. miniforge) can put wrong tools on PATH and break builds. The repo uses a wrapper that clears PATH.

### Always do

When building or testing the menu bar app or Quick Action CLI:

1. **Preferred (development):** Run the dev script from the repo root:
   ```bash
   cd macos-service/scripts
   ./dev-test.sh
   ```
   This kills old processes, builds both packages with the clean wrapper, installs the Quick Action, and opens Xcode.

2. **Manual build (Menu Bar app):**
   ```bash
   /Users/system-backup/bin/xcodebuild-clean -scheme PocketTTSMenuBar build
   ```
   Run from anywhere; use `-destination 'platform=macOS'` and `-configuration Debug` if needed.

3. **Manual build (Quick Action CLI):**
   ```bash
   /Users/system-backup/bin/xcodebuild-clean -scheme pocket-tts-quick-action build
   ```
   Binary ends up under `~/Library/Developer/Xcode/DerivedData/` (Release).

4. **When a Task/subagent is available:** Use the xcode-builder-agent (or equivalent) with `subagent_type="xcode-builder-agent"` so builds run in a clean environment.

### Schemes

- **PocketTTSMenuBar** – menu bar app (open `macos-service/PocketTTSMenuBar/Package.swift` in Xcode).
- **pocket-tts-quick-action** – Quick Action CLI (open `macos-service/PocketTTSQuickAction/Package.swift` in Xcode).

---

## Test writing (Swift/Xcode)

- **Framework:** Use XCTest. Add test targets in the relevant `Package.swift` under `macos-service/` if the project does not yet have tests.
- **Naming:** Test files: `*Tests.swift` or colocated in a `Tests` directory; test methods: `test*`.
- **Running tests:**
  - Use the same build rules: run tests via the clean wrapper or Xcode, not bare `swift test`.
  - Example with wrapper:  
    `xcodebuild test -scheme PocketTTSMenuBar -destination 'platform=macOS'` only after ensuring the build command uses `xcodebuild-clean` (e.g. invoke tests through the same environment as dev-test.sh or via Xcode’s Test action).
  - When MCP Xcode tools are available: use the run_tests tool with the appropriate scheme and destination.
- **Scope:** Prefer unit tests for services and utilities; integration-style tests for CLI or app behavior if needed. Keep business logic testable and separate from UI.

---

## Quick reference

| Task              | Command / action |
|-------------------|------------------|
| Dev cycle         | `cd macos-service/scripts && ./dev-test.sh` |
| Build menu bar    | `/Users/system-backup/bin/xcodebuild-clean -scheme PocketTTSMenuBar build` |
| Build Quick Action| `/Users/system-backup/bin/xcodebuild-clean -scheme pocket-tts-quick-action build` |
| Run tests         | Via Xcode (⌘U) or MCP run_tests; do not use `swift test` |
| Never use         | `swift build`, `swift test`, bare `xcodebuild` |
