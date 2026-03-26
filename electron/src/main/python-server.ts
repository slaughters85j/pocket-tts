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

    console.log(`Starting Python server: ${command} ${args.join(' ')} in ${cwd}`);

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

  private getCommand(model: string): string {
    if (this.isDev || this.useUvSpawn) {
      return 'uv';
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

  /**
   * Check if uv is available on PATH (needed for fish-speech in production builds).
   */
  private isUvAvailable(): boolean {
    try {
      execFileSync('uv', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
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
