#!/bin/bash

# Pocket TTS Menu Bar App Uninstaller
# Removes the menu bar app and its LaunchAgent

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'  # No Color

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

echo "Pocket TTS Menu Bar App Uninstaller"
echo "===================================="
echo ""

INSTALL_DIR="/usr/local/bin"
EXECUTABLE_NAME="PocketTTSMenuBar"
LAUNCHAGENT_PLIST="$HOME/Library/LaunchAgents/com.kyutai.pocket-tts.menubar.plist"

# Unload LaunchAgent if it exists
if [ -f "$LAUNCHAGENT_PLIST" ]; then
    echo "Unloading LaunchAgent..."
    launchctl unload "$LAUNCHAGENT_PLIST" 2>/dev/null || true
    print_success "LaunchAgent unloaded"

    # Remove LaunchAgent plist
    rm "$LAUNCHAGENT_PLIST"
    print_success "Removed LaunchAgent plist"
else
    print_warning "LaunchAgent not found (already uninstalled?)"
fi

# Remove executable if it exists
if [ -f "$INSTALL_DIR/$EXECUTABLE_NAME" ]; then
    echo "Removing menu bar app..."
    sudo rm "$INSTALL_DIR/$EXECUTABLE_NAME"
    print_success "Removed $EXECUTABLE_NAME from $INSTALL_DIR"
else
    print_warning "Executable not found (already uninstalled?)"
fi

# Kill any running instances
killall "$EXECUTABLE_NAME" 2>/dev/null || true

echo ""
print_success "Uninstallation complete!"
echo ""
echo "To reinstall:"
echo "  cd $(dirname "${BASH_SOURCE[0]}")"
echo "  ./install-menubar.sh"
echo ""
