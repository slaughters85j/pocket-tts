import { spawn, ChildProcess, execFileSync } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

export class PythonServer {
  private process: ChildProcess | null = null;
  public port: number = 0;
  private useUvSpawn: boolean = false; // true = uv run (fish-speech in prod)

  private get isDev(): boolean {
    return !app.isPackaged;
  }

  async start(): Promise<void> {
    this.port = await this.findAvailablePort();

    const model = this.getConfiguredBackend();

    // In production, fish-speech requires uv run (mlx-audio not in PyInstaller bundle).
    // Pocket-tts uses the bundled binary as before.
    this.useUvSpawn = !this.isDev && model === 'fish-speech' && this.isUvAvailable();

    if (!this.isDev && model === 'fish-speech' && !this.useUvSpawn) {
      console.warn(
        'fish-speech selected but uv not found — falling back to pocket-tts (bundled). ' +
        'Install uv (https://docs.astral.sh/uv/) for Fish Audio support in the built app.'
      );
    }

    const command = this.getCommand(model);
    const args = this.getArgs(model);
    const cwd = this.getWorkingDirectory();

    console.log(`[start] useUvSpawn=${this.useUvSpawn}, isDev=${this.isDev}, model=${model}`);
    console.log(`[start] Command: ${command} ${args.join(' ')}`);
    console.log(`[start] CWD: ${cwd}`);

    this.process = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd,
    });

    this.process.stdout?.on('data', (data) => {
      console.log(`[Python]: ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[Python Error]: ${data.toString().trim()}`);
    });

    this.process.on('error', (error) => {
      console.error('Failed to start Python server:', error);
    });

    this.process.on('exit', (code) => {
      console.log(`Python server exited with code ${code}`);
    });

    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /**
   * Restart the server with a different backend model.
   * Stops the current process, updates config, and starts fresh.
   * In production this may switch between PyInstaller (pocket-tts) and uv (fish-speech).
   */
  async restart(model: string): Promise<void> {
    console.log(`[restart] Stopping current server (port ${this.port})...`);
    await this.stop();
    // Wait for port to free up
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Update config so getConfiguredBackend reads the new model
    this.persistBackendSelection(model);
    console.log(`[restart] Config updated to model: ${model}`);
    try {
      await this.start();
      console.log(`[restart] Server restarted on port ${this.port} with model ${model}`);
    } catch (err) {
      console.error(`[restart] Failed to restart with ${model}:`, err);
      // Fall back to pocket-tts
      console.log('[restart] Falling back to pocket-tts...');
      this.persistBackendSelection('pocket-tts');
      await this.start();
      console.log(`[restart] Fallback server started on port ${this.port}`);
    }
  }

  persistBackendSelection(name: string): void {
    try {
      const configDir = path.join(
        app.getPath('home'),
        'Library',
        'Application Support',
        'pocket-tts-electron'
      );
      const configPath = path.join(configDir, 'config.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      config.selectedBackend = name;
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, Object.keys(config).sort(), 2) + '\n');
    } catch (err) {
      console.warn('Could not persist backend selection:', err);
    }
  }

  private getCommand(model: string): string {
    if (this.isDev || this.useUvSpawn) {
      return this.findUv() || 'uv';
    }
    // Production pocket-tts: use bundled Python
    const resourcePath = process.resourcesPath;
    if (process.platform === 'win32') {
      return path.join(resourcePath, 'pocket-tts-server', 'pocket-tts-server.exe');
    }
    return path.join(resourcePath, 'pocket-tts-server', 'pocket-tts-server');
  }

  private getArgs(model: string): string[] {
    if (this.isDev || this.useUvSpawn) {
      return ['run', 'pocket-tts', 'serve', '--port', this.port.toString(), '--model', model];
    }
    // Production pocket-tts bundle — fallback to pocket-tts if fish-speech was requested but uv missing
    const safeModel = this.useUvSpawn ? model : 'pocket-tts';
    return ['--port', this.port.toString(), '--model', safeModel];
  }

  /** Resolved absolute path to uv binary (cached after first lookup). */
  private uvPath: string | null = null;

  /**
   * Find the uv binary. Checks common install locations since macOS apps
   * launched via double-click don't inherit the user's shell PATH.
   */
  private findUv(): string | null {
    if (this.uvPath !== null) return this.uvPath;

    const candidates = [
      'uv', // PATH (works when launched from terminal)
      path.join(app.getPath('home'), '.local', 'bin', 'uv'),   // uv default install
      path.join(app.getPath('home'), '.cargo', 'bin', 'uv'),   // cargo install
      '/usr/local/bin/uv',
      '/opt/homebrew/bin/uv',
    ];

    for (const candidate of candidates) {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
        this.uvPath = candidate;
        console.log(`[uv] Found at: ${candidate}`);
        return candidate;
      } catch {
        // Not here, try next
      }
    }
    console.warn('[uv] Not found in any known location');
    return null;
  }

  private isUvAvailable(): boolean {
    return this.findUv() !== null;
  }

  /**
   * Read the selected backend from shared config.json.
   * Falls back to 'pocket-tts' if config is missing or unreadable.
   */
  private getConfiguredBackend(): string {
    try {
      const configDir = path.join(
        app.getPath('home'),
        'Library',
        'Application Support',
        'pocket-tts-electron'
      );
      const configPath = path.join(configDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.selectedBackend && typeof config.selectedBackend === 'string') {
          console.log(`Config: starting with backend '${config.selectedBackend}'`);
          return config.selectedBackend;
        }
      }
    } catch (err) {
      console.warn('Could not read backend from config.json, defaulting to pocket-tts:', err);
    }
    return 'pocket-tts';
  }

  private getWorkingDirectory(): string {
    if (this.isDev) {
      // In dev mode, run from the pocket-tts root directory (parent of electron/)
      return path.resolve(__dirname, '..', '..', '..');
    }
    if (this.useUvSpawn) {
      // fish-speech in production: uv needs the project root (where pyproject.toml lives).
      // The project root is stored in config or inferred from the app bundle location.
      return this.getProjectRoot();
    }
    // Production pocket-tts: run from the app resources directory
    return process.resourcesPath;
  }

  /**
   * Locate the pocket-tts project root for uv-based spawning in production.
   * Checks common locations in order of preference.
   */
  private getProjectRoot(): string {
    // 1. POCKET_TTS_PROJECT_ROOT env var (explicit override)
    const envRoot = process.env.POCKET_TTS_PROJECT_ROOT;
    if (envRoot && fs.existsSync(path.join(envRoot, 'pyproject.toml'))) {
      return envRoot;
    }

    // 2. Adjacent to the .app bundle (e.g. user cloned repo, built locally)
    //    /Users/x/dev/pocket-tts/electron/release/mac-arm64/Pocket TTS.app
    //    → project root is 4 levels up from the .app's MacOS dir
    const appPath = app.getAppPath();
    const candidates = [
      path.resolve(appPath, '..', '..', '..', '..', '..'),  // from asar inside .app
      path.resolve(appPath, '..', '..', '..'),
      path.resolve(app.getPath('home'), 'dev_local', 'pocket-tts'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'pyproject.toml'))) {
        console.log(`Found project root at: ${candidate}`);
        return candidate;
      }
    }

    // Last resort: fall back to resourcesPath
    console.warn('Could not find pocket-tts project root for uv spawn, using resourcesPath');
    return process.resourcesPath;
  }

  private async findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          const port = address.port;
          server.close(() => resolve(port));
        } else {
          reject(new Error('Failed to get port'));
        }
      });
      server.on('error', reject);
    });
  }

  private async waitForReady(timeout = 60000): Promise<void> {
    const startTime = Date.now();
    const healthUrl = `http://localhost:${this.port}/health`;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(healthUrl);
        if (response.ok) {
          console.log('Python server is ready');
          return;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Python server failed to start within timeout');
  }
}
