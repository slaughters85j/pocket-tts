#!/bin/bash
#
# rebuild-all.sh — One-shot rebuild of the Python package, Electron app,
#                  macOS Quick Action, and LaunchAgent service.
#
# Usage:
#   ./scripts/rebuild-all.sh              # rebuild everything
#   ./scripts/rebuild-all.sh --skip-electron
#   ./scripts/rebuild-all.sh --skip-macos
#   ./scripts/rebuild-all.sh --skip-electron --skip-macos   # Python only

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
err()  { echo -e "  ${RED}✗${NC} $1"; }
hdr()  { echo -e "\n${BOLD}${BLUE}── $1 ──${NC}\n"; }

# ─── Resolve project root (works regardless of where you invoke the script) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Flags ────────────────────────────────────────────────────────────────────
SKIP_ELECTRON=false
SKIP_MACOS=false

for arg in "$@"; do
    case "$arg" in
        --skip-electron) SKIP_ELECTRON=true ;;
        --skip-macos)    SKIP_MACOS=true ;;
        --help|-h)
            echo "Usage: $0 [--skip-electron] [--skip-macos]"
            exit 0
            ;;
        *)
            echo "Unknown flag: $arg"
            echo "Usage: $0 [--skip-electron] [--skip-macos]"
            exit 1
            ;;
    esac
done

echo -e "${BOLD}Pocket TTS — Full Rebuild${NC}"
echo "Project root: $PROJECT_ROOT"

FAILED_STEPS=()

# ─── Helper: scrub conda/miniforge from PATH so Swift linker isn't poisoned ──
clean_path_for_swift() {
    echo "$PATH" | tr ':' '\n' | grep -iv 'conda\|miniforge' | paste -sd ':' -
}

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Python package  (everything else depends on this)
# ═══════════════════════════════════════════════════════════════════════════════
hdr "Step 1/4: Python editable install"

cd "$PROJECT_ROOT"
if uv pip install -e . 2>&1; then
    ok "Python package installed (editable)"
else
    err "Python editable install failed"
    FAILED_STEPS+=("Python install")
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Electron app
# ═══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_ELECTRON" = true ]; then
    hdr "Step 2/4: Electron app (SKIPPED)"
else
    hdr "Step 2/4: Electron app"

    ELECTRON_DIR="$PROJECT_ROOT/electron"
    if [ ! -d "$ELECTRON_DIR" ]; then
        err "electron/ directory not found — skipping"
        FAILED_STEPS+=("Electron (missing dir)")
    else
        # 2a. npm install
        echo "  Installing npm dependencies..."
        cd "$ELECTRON_DIR"
        if npm install 2>&1; then
            ok "npm install"
        else
            err "npm install failed"
            FAILED_STEPS+=("Electron npm install")
        fi

        # 2b. Bundle Python server via PyInstaller
        echo "  Bundling Python server (PyInstaller)..."
        cd "$ELECTRON_DIR"
        if [ -x "$ELECTRON_DIR/python/bundle-python.sh" ]; then
            # bundle-python.sh resolves its own paths relative to itself
            if bash "$ELECTRON_DIR/python/bundle-python.sh" 2>&1; then
                ok "Python server bundled"
            else
                err "bundle-python.sh failed"
                FAILED_STEPS+=("Electron Python bundle")
            fi
        else
            warn "electron/python/bundle-python.sh not found or not executable — skipping bundle"
            FAILED_STEPS+=("Electron Python bundle (missing script)")
        fi

        # 2c. Build distributable
        echo "  Building Electron distributable..."
        cd "$ELECTRON_DIR"
        if npm run build:electron 2>&1; then
            ok "Electron build complete (output in electron/release/)"
        else
            err "Electron build failed"
            FAILED_STEPS+=("Electron build")
        fi
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: macOS Quick Action + Menu Bar App
# ═══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_MACOS" = true ]; then
    hdr "Step 3/4: macOS Quick Action (SKIPPED)"
else
    hdr "Step 3/4: macOS Quick Action + Menu Bar App"

    MACOS_DIR="$PROJECT_ROOT/macos-service"
    if [ ! -d "$MACOS_DIR" ]; then
        err "macos-service/ directory not found — skipping"
        FAILED_STEPS+=("macOS (missing dir)")
    else
        # Clean PATH for Swift builds
        CLEAN_PATH="$(clean_path_for_swift)"

        # 3a. Build Quick Action CLI (release)
        echo "  Building Quick Action CLI (swift build -c release)..."
        cd "$MACOS_DIR/PocketTTSQuickAction"
        if PATH="$CLEAN_PATH" swift build -c release 2>&1; then
            ok "Quick Action CLI built"
        else
            err "Quick Action CLI build failed"
            FAILED_STEPS+=("Quick Action build")
        fi

        # 3b. Install CLI binary
        BINARY_PATH="$MACOS_DIR/PocketTTSQuickAction/.build/release/pocket-tts-quick-action"
        if [ -f "$BINARY_PATH" ]; then
            echo "  Installing CLI to /usr/local/bin (requires sudo)..."
            sudo mkdir -p /usr/local/bin
            sudo cp "$BINARY_PATH" /usr/local/bin/pocket-tts-quick-action
            sudo chmod +x /usr/local/bin/pocket-tts-quick-action
            ok "CLI installed → /usr/local/bin/pocket-tts-quick-action"
        else
            err "Built binary not found at $BINARY_PATH"
            FAILED_STEPS+=("Quick Action install")
        fi

        # 3c. Install Automator workflow
        WORKFLOW_SRC="$MACOS_DIR/quick-actions/Read Selection with Pocket TTS.workflow"
        WORKFLOW_DST="$HOME/Library/Services/Read Selection with Pocket TTS.workflow"
        if [ -d "$WORKFLOW_SRC" ]; then
            echo "  Installing Quick Action workflow..."
            rm -rf "$WORKFLOW_DST"
            cp -r "$WORKFLOW_SRC" "$WORKFLOW_DST"
            ok "Workflow installed → ~/Library/Services/"

            # Refresh macOS Services menu
            /System/Library/CoreServices/pbs -flush 2>/dev/null || true
            killall pbs 2>/dev/null || true
            ok "Services menu refreshed"
        else
            warn "Workflow source not found — skipping"
        fi

        # 3d. Build Menu Bar App (debug)
        echo "  Building Menu Bar App (swift build -c debug)..."
        cd "$MACOS_DIR/PocketTTSMenuBar"
        if PATH="$CLEAN_PATH" swift build -c debug 2>&1; then
            ok "Menu Bar App built"
        else
            err "Menu Bar App build failed"
            FAILED_STEPS+=("Menu Bar App build")
        fi
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4: Restart LaunchAgent (if loaded)
# ═══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_MACOS" = true ]; then
    hdr "Step 4/4: LaunchAgent restart (SKIPPED)"
else
    hdr "Step 4/4: LaunchAgent restart"

    PLIST_LABEL="com.kyutai.pocket-tts.server"
    if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
        echo "  Restarting $PLIST_LABEL..."
        launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null && \
            ok "LaunchAgent restarted" || \
            warn "kickstart failed — try: launchctl unload/load manually"
    else
        warn "LaunchAgent not loaded (run macos-service/scripts/install-service.sh to set it up)"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}────────────────────────────────────${NC}"
if [ ${#FAILED_STEPS[@]} -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All steps completed successfully.${NC}"
else
    echo -e "${RED}${BOLD}Failures (${#FAILED_STEPS[@]}):${NC}"
    for step in "${FAILED_STEPS[@]}"; do
        err "$step"
    done
    echo ""
    exit 1
fi
echo ""
