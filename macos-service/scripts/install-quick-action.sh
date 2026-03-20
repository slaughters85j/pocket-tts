#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "Pocket TTS Quick Action Installer"
echo "======================================"
echo

# Get the script's directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
QUICK_ACTION_DIR="$PROJECT_ROOT/PocketTTSQuickAction"
WORKFLOW_DIR="$PROJECT_ROOT/quick-actions"

# Step 1: Check dependencies
echo
echo "Step 1: Checking dependencies..."
echo "--------------------------------------"

# Check ffplay (required for streaming playback)
if command -v ffplay &> /dev/null || [ -x "/opt/homebrew/bin/ffplay" ]; then
    echo -e "${GREEN}✓${NC} ffplay found"
else
    echo -e "${RED}Error: ffplay not found${NC}"
    echo "Install with: brew install ffmpeg"
    exit 1
fi

# Check uv (required for Python script)
if command -v uv &> /dev/null || [ -x "$HOME/.local/bin/uv" ]; then
    echo -e "${GREEN}✓${NC} uv found"
else
    echo -e "${YELLOW}⚠${NC} uv not found - will need to install"
    echo "Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"
fi

# Step 2: Install Python streaming script
echo
echo "Step 2: Installing Python streaming script..."
echo "--------------------------------------"

PYTHON_SCRIPT="$SCRIPT_DIR/pocket-tts-stream.py"
WRAPPER_SCRIPT="$SCRIPT_DIR/pocket-tts-stream"
SHARE_DIR="/usr/local/share/pocket-tts"
INSTALL_PATH="/usr/local/bin/pocket-tts-stream"

if [ ! -f "$PYTHON_SCRIPT" ]; then
    echo -e "${RED}Error: Python script not found at $PYTHON_SCRIPT${NC}"
    exit 1
fi

# Check if /usr/local/bin and share dir exist, create if not
if [ ! -d "/usr/local/bin" ]; then
    echo "Creating /usr/local/bin directory..."
    sudo mkdir -p /usr/local/bin
fi

if [ ! -d "$SHARE_DIR" ]; then
    echo "Creating $SHARE_DIR directory..."
    sudo mkdir -p "$SHARE_DIR"
fi

# Copy Python script to share directory
echo "Installing Python script to $SHARE_DIR..."
if sudo cp "$PYTHON_SCRIPT" "$SHARE_DIR/pocket-tts-stream.py"; then
    echo -e "${GREEN}✓${NC} Python script installed"
else
    echo -e "${RED}✗${NC} Failed to install Python script"
    exit 1
fi

# Copy wrapper script
echo "Installing wrapper to $INSTALL_PATH (requires sudo)..."
if sudo cp "$WRAPPER_SCRIPT" "$INSTALL_PATH"; then
    sudo chmod +x "$INSTALL_PATH"
    echo -e "${GREEN}✓${NC} Wrapper installed"
else
    echo -e "${RED}✗${NC} Failed to install wrapper"
    exit 1
fi

# Verify installation
if [ -x "$INSTALL_PATH" ]; then
    echo -e "${GREEN}✓${NC} Wrapper is executable"
else
    echo -e "${RED}✗${NC} Wrapper is not executable"
    exit 1
fi

# Check uv is available
if command -v uv &> /dev/null || [ -x "$HOME/.local/bin/uv" ]; then
    echo -e "${GREEN}✓${NC} uv found"
else
    echo -e "${YELLOW}⚠${NC} uv not found. Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"
fi

# Step 3: Install Quick Action workflow
echo
echo "Step 3: Installing Quick Action..."
echo "--------------------------------------"

WORKFLOW_SOURCE="$WORKFLOW_DIR/Read Selection with Pocket TTS.workflow"
WORKFLOW_DEST="$HOME/Library/Services/Read Selection with Pocket TTS.workflow"

if [ ! -d "$WORKFLOW_SOURCE" ]; then
    echo -e "${RED}Error: Workflow not found at $WORKFLOW_SOURCE${NC}"
    exit 1
fi

# Remove existing workflow if present
if [ -d "$WORKFLOW_DEST" ]; then
    echo "Removing existing workflow..."
    rm -rf "$WORKFLOW_DEST"
fi

# Copy workflow
echo "Copying workflow to ~/Library/Services/..."
if cp -r "$WORKFLOW_SOURCE" "$WORKFLOW_DEST"; then
    echo -e "${GREEN}✓${NC} Workflow installed"
else
    echo -e "${RED}✗${NC} Failed to install workflow"
    exit 1
fi

# Step 4: Create config directory if needed
echo
echo "Step 4: Setting up configuration..."
echo "--------------------------------------"

# Use pocket-tts-electron directory to match Electron app and Menu Bar app
CONFIG_DIR="$HOME/Library/Application Support/pocket-tts-electron"
CONFIG_FILE="$CONFIG_DIR/config.json"

if [ ! -d "$CONFIG_DIR" ]; then
    echo "Creating config directory..."
    mkdir -p "$CONFIG_DIR"
    echo -e "${GREEN}✓${NC} Config directory created"
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Creating default config.json..."
    cat > "$CONFIG_FILE" << 'EOF'
{
  "selectedVoiceId": "alba",
  "selectedVoiceType": "predefined",
  "serverPort": 8765,
  "autoStartServer": true,
  "version": "1.0.0"
}
EOF
    echo -e "${GREEN}✓${NC} Default config created"
else
    echo -e "${GREEN}✓${NC} Config file already exists (shared with Electron/Menu Bar apps)"
fi

# Step 5: Verify server is running
echo
echo "Step 5: Checking TTS server..."
echo "--------------------------------------"

if curl -s http://localhost:8765/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} TTS server is running"
else
    echo -e "${YELLOW}⚠${NC} TTS server is not running"
    echo "Please start the server with:"
    echo "  cd $PROJECT_ROOT/.."
    echo "  uv run pocket-tts serve --port 8765"
    echo
    echo "Or install and start the LaunchAgent:"
    echo "  $SCRIPT_DIR/install-service.sh"
fi

# Success message
echo
echo "======================================"
echo -e "${GREEN}Installation Complete!${NC}"
echo "======================================"
echo
echo "Next steps:"
echo "1. Enable the Quick Action:"
echo "   System Settings > Keyboard > Shortcuts > Services"
echo "   → Find 'Read Selection with Pocket TTS'"
echo "   → Check the box to enable it"
echo "   → Optional: Assign a keyboard shortcut (e.g., ⌥⌘R)"
echo
echo "2. Make sure the TTS server is running:"
echo "   - Use the LaunchAgent (auto-start on login)"
echo "   - Or run manually: uv run pocket-tts serve"
echo
echo "3. Test it:"
echo "   - Select text anywhere on your Mac"
echo "   - Right-click → Services → 'Read Selection with Pocket TTS'"
echo "   - Or use your keyboard shortcut"
echo
echo "Enjoy your new Quick Action!"
echo
