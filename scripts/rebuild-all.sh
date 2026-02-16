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

# ─── Per-component status tracking for summary checklist ─────────────────────
STATUS_PYTHON="pending"
STATUS_ELECTRON="skipped"
STATUS_QUICK_ACTION="skipped"
STATUS_MENUBAR="skipped"
STATUS_LAUNCHAGENT="skipped"
STATUS_APP_INSTALL="skipped"

# ─── Helper: scrub conda/miniforge from PATH so Swift linker isn't poisoned ──
clean_path_for_swift() {
    echo "$PATH" | tr ':' '\n' | grep -iv 'conda\|miniforge' | paste -sd ':' -
}

# ═══════════════════════════════════════════════════════════════════════════════
# Step 0: Sync version from pyproject.toml → electron/package.json
#         (pyproject.toml is the single source of truth for the app version)
# ═══════════════════════════════════════════════════════════════════════════════
hdr "Step 0: Version sync"

cd "$PROJECT_ROOT"
APP_VERSION=$(grep '^version' pyproject.toml | head -1 | sed 's/.*"\(.*\)"/\1/')
echo "  Version from pyproject.toml: $APP_VERSION"

# Sync into electron/package.json
ELECTRON_PKG="$PROJECT_ROOT/electron/package.json"
if [ -f "$ELECTRON_PKG" ]; then
    OLD_ELECTRON_VER=$(grep '"version"' "$ELECTRON_PKG" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')
    if [ "$OLD_ELECTRON_VER" != "$APP_VERSION" ]; then
        sed -i '' "s/\"version\": \"$OLD_ELECTRON_VER\"/\"version\": \"$APP_VERSION\"/" "$ELECTRON_PKG"
        ok "electron/package.json: $OLD_ELECTRON_VER → $APP_VERSION"
    else
        ok "electron/package.json already at $APP_VERSION"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Python package  (everything else depends on this)
# ═══════════════════════════════════════════════════════════════════════════════
hdr "Step 1/4: Python editable install"

cd "$PROJECT_ROOT"
if uv pip install -e . 2>&1; then
    ok "Python package installed (editable)"
    STATUS_PYTHON="done"
else
    err "Python editable install failed"
    FAILED_STEPS+=("Python install")
    STATUS_PYTHON="failed"
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
            STATUS_ELECTRON="done"
        else
            err "Electron build failed"
            FAILED_STEPS+=("Electron build")
            STATUS_ELECTRON="failed"
        fi

        # 2d. Copy .app to /Applications
        APP_BUNDLE=$(find "$ELECTRON_DIR/release" -maxdepth 2 -name "Pocket TTS.app" -type d 2>/dev/null | head -n 1)
        if [ -n "$APP_BUNDLE" ]; then
            echo "  Installing Pocket TTS.app to /Applications..."
            if [ -d "/Applications/Pocket TTS.app" ]; then
                rm -rf "/Applications/Pocket TTS.app"
            fi
            cp -R "$APP_BUNDLE" "/Applications/Pocket TTS.app"
            ok "Pocket TTS.app → /Applications/"
            STATUS_APP_INSTALL="done"
        else
            warn "Pocket TTS.app not found in electron/release/ — skipping /Applications install"
            STATUS_APP_INSTALL="failed"
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
            STATUS_QUICK_ACTION="done"
        else
            err "Quick Action CLI build failed"
            FAILED_STEPS+=("Quick Action build")
            STATUS_QUICK_ACTION="failed"
        fi

        # 3b. Sign and install CLI binary
        BINARY_PATH="$MACOS_DIR/PocketTTSQuickAction/.build/release/pocket-tts-quick-action"
        if [ -f "$BINARY_PATH" ]; then
            echo "  Signing binary with ad-hoc codesign (required for Automator Quick Actions)..."
            codesign --force --sign - "$BINARY_PATH"
            echo "  Installing CLI to /usr/local/bin (requires sudo)..."
            sudo mkdir -p /usr/local/bin
            sudo cp "$BINARY_PATH" /usr/local/bin/pocket-tts-quick-action
            sudo chmod +x /usr/local/bin/pocket-tts-quick-action
            ok "CLI signed and installed → /usr/local/bin/pocket-tts-quick-action"
        else
            err "Built binary not found at $BINARY_PATH"
            FAILED_STEPS+=("Quick Action install")
            STATUS_QUICK_ACTION="failed"
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

        # 3d. Kill running Menu Bar App (so the old binary isn't stale)
        if pgrep -x "PocketTTSMenuBar" > /dev/null; then
            echo "  Killing existing PocketTTSMenuBar..."
            killall PocketTTSMenuBar 2>/dev/null || true
            sleep 1
            ok "Menu Bar App terminated"
        fi

        # 3e. Build Menu Bar App (debug)
        echo "  Building Menu Bar App (swift build -c debug)..."
        cd "$MACOS_DIR/PocketTTSMenuBar"
        if PATH="$CLEAN_PATH" swift build -c debug 2>&1; then
            ok "Menu Bar App built"

            # 3f. Install and relaunch Menu Bar App
            MENUBAR_BINARY="$MACOS_DIR/PocketTTSMenuBar/.build/debug/PocketTTSMenuBar"
            if [ -f "$MENUBAR_BINARY" ]; then
                echo "  Installing Menu Bar App to /usr/local/bin..."
                sudo cp "$MENUBAR_BINARY" /usr/local/bin/PocketTTSMenuBar
                sudo chmod +x /usr/local/bin/PocketTTSMenuBar
                ok "Menu Bar App installed → /usr/local/bin/PocketTTSMenuBar"

                echo "  Launching Menu Bar App..."
                nohup /usr/local/bin/PocketTTSMenuBar &>/dev/null &
                disown
                ok "Menu Bar App launched"
            else
                warn "Menu Bar binary not found at $MENUBAR_BINARY — skipping install"
            fi

            STATUS_MENUBAR="done"
        else
            err "Menu Bar App build failed"
            FAILED_STEPS+=("Menu Bar App build")
            STATUS_MENUBAR="failed"
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
            { ok "LaunchAgent restarted"; STATUS_LAUNCHAGENT="done"; } || \
            { warn "kickstart failed — try: launchctl unload/load manually"; STATUS_LAUNCHAGENT="failed"; }
    else
        warn "LaunchAgent not loaded (run macos-service/scripts/install-service.sh to set it up)"
        STATUS_LAUNCHAGENT="not loaded"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

# Helper to render a status icon
status_icon() {
    case "$1" in
        done)       echo -e "${GREEN}✓${NC}" ;;
        failed)     echo -e "${RED}✗${NC}" ;;
        skipped)    echo -e "${YELLOW}–${NC}" ;;
        *)          echo -e "${YELLOW}⚠${NC}" ;;
    esac
}

echo ""
echo -e "${BOLD}════════════════════════════════════════${NC}"
if [ ${#FAILED_STEPS[@]} -eq 0 ]; then
    echo -e "${GREEN}${BOLD}  All steps completed successfully.${NC}"
else
    echo -e "${RED}${BOLD}  Completed with ${#FAILED_STEPS[@]} failure(s)${NC}"
fi
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo ""
echo -e "  $(status_icon "$STATUS_PYTHON")  Python package"
echo -e "  $(status_icon "$STATUS_ELECTRON")  Electron app build"
echo -e "  $(status_icon "$STATUS_APP_INSTALL")  Pocket TTS.app → /Applications"
echo -e "  $(status_icon "$STATUS_QUICK_ACTION")  Quick Action CLI"
echo -e "  $(status_icon "$STATUS_MENUBAR")  Menu Bar App"
echo -e "  $(status_icon "$STATUS_LAUNCHAGENT")  LaunchAgent"
echo ""

if [ ${#FAILED_STEPS[@]} -gt 0 ]; then
    exit 1
fi
