import { app, BrowserWindow, ipcMain, Menu, MenuItem } from 'electron';
import * as path from 'path';
import { PythonServer } from './python-server';
import { registerIpcHandlers, registerEnhancementHandlers, cleanupEnhancer } from './ipc-handlers';
import { registerVoiceHandlers, getVoiceManager } from './voice-manager';
import { registerChatHandlers } from './llm-handler';

let mainWindow: BrowserWindow | null = null;
let pythonServer: PythonServer | null = null;

function isDev(): boolean {
  return !app.isPackaged;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 1270,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev()) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const htmlPath = path.join(__dirname, '../renderer/index.html');
    console.log('Loading HTML from:', htmlPath);
    console.log('__dirname:', __dirname);
    mainWindow.loadFile(htmlPath);
  }

  // DevTools off by default - can be toggled via IPC

  // Spellcheck context menu — right-click shows OS-style spelling suggestions
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    // Add spelling suggestions
    if (params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(
          new MenuItem({
            label: suggestion,
            click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
          })
        );
      }
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // "Add to Dictionary" for misspelled words
    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: `Add "${params.misspelledWord}" to dictionary`,
          click: () =>
            mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // Standard edit actions for text fields
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ role: 'selectAll', enabled: params.editFlags.canSelectAll }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
    }

    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // Log any load failures
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function startPythonServer() {
  pythonServer = new PythonServer();
  try {
    await pythonServer.start();
    console.log(`Python server started on port ${pythonServer.port}`);
  } catch (error) {
    console.error('Failed to start Python server:', error);
    throw error;
  }
}

app.whenReady().then(async () => {
  registerVoiceHandlers();

  // Create window first so user sees the app
  await createWindow();

  // Register IPC handlers with getter to access current server state
  const vm = getVoiceManager();
  registerIpcHandlers(() => pythonServer, vm);
  registerEnhancementHandlers(vm);
  registerChatHandlers(() => pythonServer, vm);

  try {
    await startPythonServer();
    console.log('Python server started successfully');
  } catch (error) {
    console.error('Failed to start Python server:', error);
    // Show error in the window after it's ready
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.executeJavaScript(
        `console.error('TTS server failed to start'); alert('Failed to start TTS server: ${String(error).replace(/'/g, "\\'")}\\n\\nMake sure the Python server is bundled or run in dev mode.')`
      );
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  cleanupEnhancer();
  if (pythonServer) {
    await pythonServer.stop();
  }
});

ipcMain.handle('get-server-port', () => {
  return pythonServer?.port ?? 8000;
});

ipcMain.handle('start-dictation', () => {
  // Trigger macOS dictation via AppleScript
  const { execFile } = require('child_process');
  execFile('osascript', ['-e',
    'tell application "System Events" to tell (first process whose frontmost is true) to tell menu bar 1 to tell menu "Edit" to click menu item "Start Dictation…"'
  ], (err: any) => {
    if (err) console.log('[ChatLLM] Dictation trigger failed:', err.message);
  });
});

ipcMain.handle('toggle-devtools', () => {
  if (mainWindow) {
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
    } else {
      mainWindow.webContents.openDevTools();
    }
  }
});
