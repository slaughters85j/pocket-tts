#!/bin/bash

# Pocket TTS Menu Bar App Installer
# Installs the menu bar app and creates a LaunchAgent for auto-start

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

echo "Pocket TTS Menu Bar App Installer"
echo "=================================="
echo ""

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/../PocketTTSMenuBar"
PLIST_FILE="$SCRIPT_DIR/../launchd/com.kyutai.pocket-tts.menubar.plist"
INSTALL_DIR="/usr/local/bin"
EXECUTABLE_NAME="PocketTTSMenuBar"
LAUNCHAGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCHAGENT_PLIST="$LAUNCHAGENT_DIR/com.kyutai.pocket-tts.menubar.plist"

# Check if already installed
if [ -f "$INSTALL_DIR/$EXECUTABLE_NAME" ]; then
    print_warning "Menu bar app already installed at $INSTALL_DIR/$EXECUTABLE_NAME"
    read -p "Replace with new version? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Skipping installation"
    else
        # Find the built executable
        EXECUTABLE_PATH="$PROJECT_DIR/.build/arm64-apple-macosx/release/$EXECUTABLE_NAME"

        if [ ! -f "$EXECUTABLE_PATH" ]; then
            print_error "Executable not found at: $EXECUTABLE_PATH"
            echo ""
            echo "Please build the menu bar app first:"
            echo "  cd $PROJECT_DIR"
            echo "  swift build -c release"
            echo ""
            exit 1
        fi

        # Install executable
        echo ""
        echo "Installing menu bar app to $INSTALL_DIR..."
        sudo mkdir -p "$INSTALL_DIR"
        sudo cp "$EXECUTABLE_PATH" "$INSTALL_DIR/"
        sudo chmod +x "$INSTALL_DIR/$EXECUTABLE_NAME"
        print_success "Installed $EXECUTABLE_NAME to $INSTALL_DIR"
    fi
else
    # Find the built executable
    EXECUTABLE_PATH="$PROJECT_DIR/.build/arm64-apple-macosx/release/$EXECUTABLE_NAME"

    if [ ! -f "$EXECUTABLE_PATH" ]; then
        print_error "Executable not found at: $EXECUTABLE_PATH"
        echo ""
        echo "Please build the menu bar app first:"
        echo "  cd $PROJECT_DIR"
        echo "  swift build -c release"
        echo ""
        exit 1
    fi

    # Install executable
    echo "Installing menu bar app to $INSTALL_DIR..."
    sudo mkdir -p "$INSTALL_DIR"
    sudo cp "$EXECUTABLE_PATH" "$INSTALL_DIR/"
    sudo chmod +x "$INSTALL_DIR/$EXECUTABLE_NAME"
    print_success "Installed $EXECUTABLE_NAME to $INSTALL_DIR"
fi

# Check if LaunchAgent plist exists
if [ ! -f "$PLIST_FILE" ]; then
    print_error "LaunchAgent plist not found at: $PLIST_FILE"
    exit 1
fi

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$LAUNCHAGENT_DIR"

# Check if LaunchAgent already installed
if [ -f "$LAUNCHAGENT_PLIST" ]; then
    print_warning "LaunchAgent already installed"

    # Unload existing agent
    launchctl unload "$LAUNCHAGENT_PLIST" 2>/dev/null || true
    print_success "Unloaded existing LaunchAgent"
fi

# Copy plist to LaunchAgents directory
cp "$PLIST_FILE" "$LAUNCHAGENT_PLIST"
print_success "Installed LaunchAgent plist"

# Load the LaunchAgent
launchctl load "$LAUNCHAGENT_PLIST"
print_success "Loaded LaunchAgent"

echo ""
print_success "Installation complete!"
echo ""
echo "The menu bar app will now:"
echo "  • Start automatically on login"
echo "  • Restart automatically if it crashes"
echo "  • Appear in the menu bar with a microphone icon"
echo ""
echo "To uninstall:"
echo "  cd $SCRIPT_DIR"
echo "  ./uninstall-menubar.sh"
echo ""
echo "To view logs:"
echo "  tail -f /tmp/pocket-tts-menubar.log"
echo "  tail -f /tmp/pocket-tts-menubar-error.log"
echo ""
