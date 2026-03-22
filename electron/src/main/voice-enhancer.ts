import { app } from 'electron';
import { execFile, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface EnhanceOptions {
  denoise: boolean;
  targetSr?: number; // default 24000
  device?: string; // 'auto' | 'cpu' | 'mps'
  rmsTargetDb?: number; // RMS normalization baked into the WAV (e.g., -14)
}

export interface EnhanceResult {
  tempOutputPath: string;
  outputSr: number;
  device: string;
  denoise: boolean;
  rmsTargetDb?: number;
  preRmsDb?: number;
  postRmsDb?: number;
}

/** Tri-state: venv ready, script exists but no venv, or completely unavailable */
export type EnhanceAvailability = 'ready' | 'needs-setup' | 'unavailable';

type ProgressCallback = (status: string, details?: Record<string, unknown>) => void;

/**
 * Manages LavaSR voice enhancement as a sidecar subprocess.
 * Enhancement runs in a separate Python process to avoid blocking
 * the TTS server (which is not thread-safe).
 *
 * On first use, bootstraps a dedicated venv at:
 *   ~/Library/Application Support/pocket-tts-electron/lavasr-venv/
 */
export class VoiceEnhancer {
  private tempFiles: Set<string> = new Set();
  private currentProcess: ChildProcess | null = null;
  private pendingResult: EnhanceResult | null = null;
  private setupProcess: ChildProcess | null = null;

  /**
   * Get path to the enhance-voice.py script.
   * In dev mode: electron/resources/enhance-voice.py
   * In production: bundled alongside the app
   */
  private getScriptPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'enhance-voice.py');
    }
    return path.join(__dirname, '../../resources/enhance-voice.py');
  }

  /** Path to the self-contained LavaSR venv */
  private getVenvDir(): string {
    return path.join(app.getPath('userData'), 'lavasr-venv');
  }

  /** Path to the Python binary inside the LavaSR venv */
  private getVenvPython(): string {
    return path.join(this.getVenvDir(), 'bin', 'python');
  }

  /**
   * Get path to the Python executable.
   * Only uses the app's own venv — no external fallbacks.
   */
  private getPythonPath(): string {
    const venvPython = this.getVenvPython();
    if (fs.existsSync(venvPython)) {
      return venvPython;
    }
    // Bare python3 won't have deps, but lets isAvailable() return 'needs-setup'
    return 'python3';
  }

  /**
   * Resolve the `uv` binary path.
   * Checks common locations since Electron's PATH may not include ~/.local/bin.
   */
  private getUvPath(): string {
    const candidates = [
      path.join(os.homedir(), '.local/bin/uv'),
      '/usr/local/bin/uv',
      '/opt/homebrew/bin/uv',
      'uv', // fall back to PATH
    ];
    for (const candidate of candidates) {
      if (candidate === 'uv') return candidate;
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'uv';
  }

  /**
   * Check LavaSR enhancement availability (tri-state).
   * - 'ready': venv exists and LavaSR imports successfully
   * - 'needs-setup': enhance script exists but venv is missing or broken
   * - 'unavailable': enhance script not found (not bundled)
   */
  async checkAvailability(): Promise<EnhanceAvailability> {
    const scriptPath = this.getScriptPath();
    if (!fs.existsSync(scriptPath)) {
      return 'unavailable';
    }

    const venvPython = this.getVenvPython();
    if (!fs.existsSync(venvPython)) {
      return 'needs-setup';
    }

    return new Promise((resolve) => {
      execFile(
        venvPython,
        ['-c', 'from LavaSR.model import LavaEnhance2; print("ok")'],
        { timeout: 15000 },
        (err) => {
          resolve(err ? 'needs-setup' : 'ready');
        }
      );
    });
  }

  /**
   * Legacy boolean check — returns true only if fully ready.
   */
  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()) === 'ready';
  }

  /**
   * Bootstrap the LavaSR venv with all required dependencies.
   * Creates a venv via `uv`, installs torch + torchaudio (CPU), soundfile, and LavaSR.
   * Reports progress via callback for UI feedback.
   *
   * Idempotent — safe to call if venv already exists (will verify/repair).
   */
  async setupVenv(onProgress?: ProgressCallback): Promise<void> {
    const uvPath = this.getUvPath();
    const venvDir = this.getVenvDir();
    const venvPython = this.getVenvPython();

    // Step 1: Create venv if it doesn't exist
    if (!fs.existsSync(venvPython)) {
      onProgress?.('creating-venv', { message: 'Creating Python virtual environment...' });
      await this.runCommand(uvPath, ['venv', venvDir, '--python', '3.12']);
    }

    // Step 2: Install PyTorch CPU (smaller than full CUDA build)
    onProgress?.('installing-torch', {
      message: 'Installing PyTorch (this may take a minute)...',
    });
    await this.runCommand(uvPath, [
      'pip',
      'install',
      '--python',
      venvPython,
      'torch',
      'torchaudio',
      '--index-url',
      'https://download.pytorch.org/whl/cpu',
    ]);

    // Step 3: Install soundfile
    onProgress?.('installing-soundfile', { message: 'Installing soundfile...' });
    await this.runCommand(uvPath, ['pip', 'install', '--python', venvPython, 'soundfile']);

    // Step 4: Install LavaSR from GitHub
    onProgress?.('installing-lavasr', {
      message: 'Installing LavaSR from GitHub...',
    });
    await this.runCommand(uvPath, [
      'pip',
      'install',
      '--python',
      venvPython,
      'git+https://github.com/ysharma3501/LavaSR.git',
    ]);

    // Step 5: Verify the install actually works
    onProgress?.('verifying', { message: 'Verifying LavaSR installation...' });
    await new Promise<void>((resolve, reject) => {
      execFile(
        venvPython,
        ['-c', 'from LavaSR.model import LavaEnhance2; print("ok")'],
        { timeout: 15000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`LavaSR verification failed: ${stderr || err.message}`));
          } else {
            resolve();
          }
        }
      );
    });

    onProgress?.('done', { message: 'LavaSR setup complete!' });
  }

  /**
   * Cancel an in-progress setup.
   */
  cancelSetup(): void {
    if (this.setupProcess) {
      this.setupProcess.kill('SIGTERM');
      this.setupProcess = null;
    }
  }

  /**
   * Run a shell command and return a promise. Stores the child process
   * in setupProcess so it can be cancelled.
   */
  private runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        command,
        args,
        {
          timeout: 600000, // 10 min timeout for large installs
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          env: { ...process.env, PATH: `${path.dirname(command)}:${process.env.PATH}` },
        },
        (error, stdout, stderr) => {
          this.setupProcess = null;
          if (error) {
            reject(new Error(`Command failed: ${command} ${args.join(' ')}\n${stderr || error.message}`));
          } else {
            resolve(stdout);
          }
        }
      );
      this.setupProcess = proc;
    });
  }

  /**
   * Run LavaSR enhancement on an audio file.
   * Returns path to the temp enhanced file for preview.
   */
  async enhancePreview(
    inputPath: string,
    options: EnhanceOptions,
    onProgress?: ProgressCallback
  ): Promise<EnhanceResult> {
    const scriptPath = this.getScriptPath();
    const pythonPath = this.getPythonPath();

    if (!fs.existsSync(scriptPath)) {
      throw new Error('Enhancement script not found. Is LavaSR installed?');
    }

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const sessionId = randomUUID();
    const tempOutputPath = path.join(
      os.tmpdir(),
      `pocket-tts-enhance-${sessionId}-output.wav`
    );

    this.tempFiles.add(tempOutputPath);

    const args = [
      scriptPath,
      '--input',
      inputPath,
      '--output',
      tempOutputPath,
      '--device',
      options.device ?? 'auto',
      '--target-sr',
      String(options.targetSr ?? 24000),
    ];

    if (!options.denoise) {
      args.push('--no-denoise');
    }

    if (options.rmsTargetDb !== undefined) {
      args.push('--rms-target-db', String(options.rmsTargetDb));
    }

    return new Promise<EnhanceResult>((resolve, reject) => {
      const proc = execFile(
        pythonPath,
        args,
        {
          timeout: 120000, // 2 minute timeout
          maxBuffer: 1024 * 1024, // 1MB stdout buffer
        },
        (error, stdout, stderr) => {
          this.currentProcess = null;

          if (error) {
            // Try to parse JSON error from stdout
            const lines = (stdout || '').trim().split('\n');
            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                if (msg.status === 'error') {
                  this.cleanupFile(tempOutputPath);
                  reject(new Error(msg.message || 'Enhancement failed'));
                  return;
                }
              } catch {
                // not JSON, skip
              }
            }
            this.cleanupFile(tempOutputPath);
            reject(new Error(`Enhancement failed: ${error.message}\n${stderr || ''}`));
            return;
          }

          // Parse the final status from stdout
          const lines = (stdout || '').trim().split('\n');
          let result: EnhanceResult = {
            tempOutputPath,
            outputSr: options.targetSr ?? 24000,
            device: options.device ?? 'auto',
            denoise: options.denoise,
          };

          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              if (msg.status === 'done') {
                result = {
                  tempOutputPath,
                  outputSr: msg.output_sr ?? result.outputSr,
                  device: msg.device ?? result.device,
                  denoise: msg.denoise ?? result.denoise,
                  rmsTargetDb: msg.rms_target_db ?? undefined,
                  preRmsDb: msg.pre_rms_db ?? undefined,
                  postRmsDb: msg.post_rms_db ?? undefined,
                };
              }
            } catch {
              // not JSON, skip
            }
          }

          if (!fs.existsSync(tempOutputPath)) {
            reject(new Error('Enhancement completed but output file not found'));
            return;
          }

          this.pendingResult = result;
          resolve(result);
        }
      );

      this.currentProcess = proc;

      // Stream progress from stdout
      if (proc.stdout && onProgress) {
        let buffer = '';
        proc.stdout.on('data', (data: string | Buffer) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              onProgress(msg.status, msg);
            } catch {
              // not JSON, skip
            }
          }
        });
      }
    });
  }

  /**
   * Get the pending enhancement result (for accept/reject workflow).
   */
  getPendingResult(): EnhanceResult | null {
    return this.pendingResult;
  }

  /**
   * Clear the pending result after accept or reject.
   */
  clearPendingResult(): void {
    this.pendingResult = null;
  }

  /**
   * Cancel any running enhancement process.
   */
  cancel(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  /**
   * Clean up a single temp file.
   */
  private cleanupFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore cleanup errors
    }
    this.tempFiles.delete(filePath);
  }

  /**
   * Clean up all temp files (call on reject or app quit).
   */
  cleanup(): void {
    Array.from(this.tempFiles).forEach((filePath) => {
      this.cleanupFile(filePath);
    });
    this.tempFiles.clear();
    this.pendingResult = null;
  }
}
