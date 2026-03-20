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
}

export interface EnhanceResult {
  tempOutputPath: string;
  outputSr: number;
  device: string;
  denoise: boolean;
}

type ProgressCallback = (status: string, details?: Record<string, unknown>) => void;

/**
 * Manages LavaSR voice enhancement as a sidecar subprocess.
 * Enhancement runs in a separate Python process to avoid blocking
 * the TTS server (which is not thread-safe).
 */
export class VoiceEnhancer {
  private tempFiles: Set<string> = new Set();
  private currentProcess: ChildProcess | null = null;
  private pendingResult: EnhanceResult | null = null;

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

  /**
   * Get path to the Python executable.
   * Uses the LavaSR venv if it exists, otherwise falls back to system uv/python.
   */
  private getPythonPath(): string {
    const userDataPath = app.getPath('userData');
    const venvPython = path.join(userDataPath, 'lavasr-venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) {
      return venvPython;
    }

    // Fall back to the clawd scripts venv (dev machine)
    const clawdVenvPython = path.join(
      os.homedir(),
      'clawd/scripts/lavasr-enhance/.venv/bin/python'
    );
    if (fs.existsSync(clawdVenvPython)) {
      return clawdVenvPython;
    }

    return 'python3';
  }

  /**
   * Check if LavaSR enhancement is available.
   */
  async isAvailable(): Promise<boolean> {
    const scriptPath = this.getScriptPath();
    if (!fs.existsSync(scriptPath)) {
      return false;
    }

    const pythonPath = this.getPythonPath();

    return new Promise((resolve) => {
      execFile(
        pythonPath,
        ['-c', 'from LavaSR.model import LavaEnhance2; print("ok")'],
        { timeout: 10000 },
        (err) => {
          resolve(!err);
        }
      );
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
