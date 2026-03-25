import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { PythonServer } from './python-server';
import { VoiceEnhancer } from './voice-enhancer';

interface TTSParams {
  text: string;
  voiceUrl?: string;
  voiceFile?: ArrayBuffer;
  savedVoiceId?: string;
  rmsTargetDb?: number;
}

interface SpeakerConfig {
  name: string;
  voice_source: string;
  voice_data: string | null;
  seed: number | null;
  rms_target_db?: number;
}

interface MultiTTSParams {
  script: string;
  speakers: SpeakerConfig[];
  crossfade_ms?: number;
}

// Module-level abort controller for cancelling in-flight TTS requests
let currentAbortController: AbortController | null = null;

export function registerIpcHandlers(
  getPythonServer: () => PythonServer | null,
  voiceManager: { getVoiceFilePath: (id: string) => string | null }
) {
  ipcMain.handle('tts:generate', async (event: IpcMainInvokeEvent, params: TTSParams) => {
    const { text, voiceUrl, voiceFile, savedVoiceId, rmsTargetDb } = params;
    const sender = event.sender;

    const pythonServer = getPythonServer();
    if (!pythonServer || !pythonServer.port) {
      sender.send('tts:error', 'TTS server is not running. Please restart the app or check the Python server.');
      return;
    }

    // Cancel any previous in-flight request
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    const abortController = new AbortController();
    currentAbortController = abortController;

    try {
      const formData = new FormData();
      formData.append('text', text);

      if (voiceFile) {
        const blob = new Blob([voiceFile], { type: 'audio/wav' });
        formData.append('voice_wav', blob, 'voice.wav');
      } else if (savedVoiceId) {
        // Load saved voice from file system
        const filePath = voiceManager.getVoiceFilePath(savedVoiceId);
        if (filePath && fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath);
          const blob = new Blob([buffer], { type: 'audio/wav' });
          formData.append('voice_wav', blob, 'voice.wav');
        } else {
          throw new Error('Saved voice file not found');
        }
      } else if (voiceUrl) {
        formData.append('voice_url', voiceUrl);
      }

      // Pass per-voice RMS normalization target if provided
      if (rmsTargetDb !== undefined) {
        formData.append('rms_target_db', rmsTargetDb.toString());
      }

      const response = await fetch(`http://localhost:${pythonServer.port}/tts`, {
        method: 'POST',
        body: formData,
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value && !sender.isDestroyed()) {
          sender.send('tts:chunk', value.buffer);
        }
      }

      if (!sender.isDestroyed()) {
        sender.send('tts:complete');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Request was cancelled by user — not an error
        if (!sender.isDestroyed()) {
          sender.send('tts:cancelled');
        }
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (!sender.isDestroyed()) {
          sender.send('tts:error', errorMessage);
        }
      }
    } finally {
      if (currentAbortController === abortController) {
        currentAbortController = null;
      }
    }
  });

  // Multi-Talk TTS handler
  ipcMain.handle('tts:generate-multi', async (event: IpcMainInvokeEvent, params: MultiTTSParams) => {
    const { script, speakers, crossfade_ms = 100 } = params;
    const sender = event.sender;

    const pythonServer = getPythonServer();
    if (!pythonServer || !pythonServer.port) {
      sender.send('tts:error', 'TTS server is not running. Please restart the app or check the Python server.');
      return;
    }

    // Cancel any previous in-flight request
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    const abortController = new AbortController();
    currentAbortController = abortController;

    try {
      // Resolve saved voices to base64 data
      const resolvedSpeakers = speakers.map((speaker) => {
        if (speaker.voice_source.startsWith('saved:')) {
          const savedVoiceId = speaker.voice_source.replace('saved:', '');
          const filePath = voiceManager.getVoiceFilePath(savedVoiceId);
          if (filePath && fs.existsSync(filePath)) {
            const buffer = fs.readFileSync(filePath);
            const base64Data = buffer.toString('base64');
            return {
              ...speaker,
              voice_source: 'uploaded',
              voice_data: base64Data,
            };
          } else {
            throw new Error(`Saved voice file not found for speaker "${speaker.name}"`);
          }
        }
        return speaker;
      });

      const formData = new FormData();
      formData.append('script', script);
      formData.append('speakers', JSON.stringify(resolvedSpeakers));
      formData.append('crossfade_ms', crossfade_ms.toString());

      const response = await fetch(`http://localhost:${pythonServer.port}/multi-tts`, {
        method: 'POST',
        body: formData,
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.detail || `Server error: ${response.status}`);
        } catch {
          throw new Error(`Server error: ${response.status} - ${errorText}`);
        }
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value && !sender.isDestroyed()) {
          sender.send('tts:chunk', value.buffer);
        }
      }

      if (!sender.isDestroyed()) {
        sender.send('tts:complete');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (!sender.isDestroyed()) {
          sender.send('tts:cancelled');
        }
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (!sender.isDestroyed()) {
          sender.send('tts:error', errorMessage);
        }
      }
    } finally {
      if (currentAbortController === abortController) {
        currentAbortController = null;
      }
    }
  });

  // Cancel in-flight TTS request
  ipcMain.handle('tts:cancel', async () => {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  });

  // Convert WAV to M4A (AAC) using system ffmpeg
  ipcMain.handle('audio:convert-to-m4a', async (_event: IpcMainInvokeEvent, wavBuffer: ArrayBuffer): Promise<ArrayBuffer> => {
    const tmpDir = os.tmpdir();
    const id = Date.now().toString(36);
    const wavPath = path.join(tmpDir, `pocket-tts-${id}.wav`);
    const m4aPath = path.join(tmpDir, `pocket-tts-${id}.m4a`);

    try {
      fs.writeFileSync(wavPath, Buffer.from(wavBuffer));

      await new Promise<void>((resolve, reject) => {
        // Try ffmpeg first, fall back to macOS afconvert
        const tryFfmpeg = () => {
          execFile('ffmpeg', [
            '-i', wavPath,
            '-ac', '2',           // stereo output
            '-c:a', 'aac',
            '-b:a', '192k',
            '-y',                  // overwrite
            m4aPath,
          ], (err) => {
            if (err) {
              // ffmpeg not found — try macOS afconvert
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                tryAfconvert();
              } else {
                reject(new Error(`ffmpeg failed: ${err.message}`));
              }
            } else {
              resolve();
            }
          });
        };

        const tryAfconvert = () => {
          execFile('afconvert', [
            '-f', 'm4af',
            '-d', 'aac',
            '-b', '192000',
            '-c', '2',
            wavPath,
            m4aPath,
          ], (err) => {
            if (err) {
              reject(new Error(
                'M4A encoding requires ffmpeg or macOS afconvert. ' +
                'Install ffmpeg: brew install ffmpeg'
              ));
            } else {
              resolve();
            }
          });
        };

        tryFfmpeg();
      });

      const m4aBuffer = fs.readFileSync(m4aPath);
      return m4aBuffer.buffer.slice(m4aBuffer.byteOffset, m4aBuffer.byteOffset + m4aBuffer.byteLength);
    } finally {
      // Clean up temp files
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
      try { fs.unlinkSync(m4aPath); } catch { /* ignore */ }
    }
  });

  // Check if M4A encoding is available (ffmpeg or afconvert)
  ipcMain.handle('audio:m4a-available', async (): Promise<boolean> => {
    return new Promise((resolve) => {
      execFile('ffmpeg', ['-version'], (err) => {
        if (!err) { resolve(true); return; }
        // Try macOS afconvert as fallback
        execFile('afconvert', ['--help'], (err2) => {
          resolve(!err2);
        });
      });
    });
  });

  // ------------------------------------------------------------------
  // Backend management
  // ------------------------------------------------------------------

  ipcMain.handle(
    'backend:list',
    async (): Promise<{ available: string[]; active: string | null; supports_tags: boolean }> => {
      const pythonServer = getPythonServer();
      if (!pythonServer || !pythonServer.port) {
        return { available: ['pocket-tts'], active: null, supports_tags: false };
      }
      try {
        const response = await fetch(`http://localhost:${pythonServer.port}/backends`);
        return await response.json();
      } catch {
        return { available: ['pocket-tts'], active: null, supports_tags: false };
      }
    }
  );

  ipcMain.handle('backend:switch', async (_event: IpcMainInvokeEvent, name: string) => {
    const pythonServer = getPythonServer();
    if (!pythonServer || !pythonServer.port) {
      throw new Error('TTS server is not running');
    }
    const response = await fetch(`http://localhost:${pythonServer.port}/switch-backend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: name }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend switch failed: ${response.status} - ${errorText}`);
    }
    const result = await response.json();

    // Persist selection to shared config.json so Menu Bar / Quick Action / next launch pick it up
    try {
      const configDir = path.join(
        os.homedir(),
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
      console.warn('Could not persist backend selection to config.json:', err);
    }

    return result;
  });
}

// ─── Voice Enhancement Handlers ──────────────────────────────────────────────

const voiceEnhancer = new VoiceEnhancer();

export function registerEnhancementHandlers(
  voiceManager: {
    getVoiceFilePath: (id: string) => string | null;
    getVoiceAudioBuffer: (id: string) => Promise<Buffer | null>;
    getSavedVoices: () => Promise<import('./voice-manager').SavedVoice[]>;
    replaceVoiceFile: (
      id: string,
      newFilePath: string,
      meta: { denoise: boolean; device: string }
    ) => Promise<import('./voice-manager').SavedVoice | null>;
    updateVoiceMetadata: (
      id: string,
      updates: Partial<import('./voice-manager').SavedVoice>
    ) => Promise<import('./voice-manager').SavedVoice | null>;
  }
) {
  // Check LavaSR enhancement availability (tri-state)
  ipcMain.handle(
    'voice:enhance-available',
    async (): Promise<import('./voice-enhancer').EnhanceAvailability> => {
      return voiceEnhancer.checkAvailability();
    }
  );

  // Bootstrap the LavaSR venv (first-time setup)
  ipcMain.handle('voice:enhance-setup', async (event: IpcMainInvokeEvent): Promise<void> => {
    const sender = event.sender;
    await voiceEnhancer.setupVenv((status, details) => {
      if (!sender.isDestroyed()) {
        sender.send('enhance:setup-progress', status, details);
      }
    });
  });

  // Cancel an in-progress setup
  ipcMain.handle('voice:enhance-setup-cancel', async (): Promise<void> => {
    voiceEnhancer.cancelSetup();
  });

  // Run enhancement and return both original + enhanced audio for A/B preview
  ipcMain.handle(
    'voice:enhance-preview',
    async (
      event: IpcMainInvokeEvent,
      params: {
        voiceId?: string;
        audioData?: ArrayBuffer;
        denoise: boolean;
        rmsTargetDb?: number;
        useOriginalBackup?: boolean;
      }
    ): Promise<{ original: ArrayBuffer; enhanced: ArrayBuffer }> => {
      const sender = event.sender;
      let inputPath: string;
      let tempInputCreated = false;

      if (params.voiceId) {
        if (params.useOriginalBackup) {
          // Edit Enhancement: source from the pre-enhancement backup
          const voices = await voiceManager.getSavedVoices();
          const voice = voices.find((v: import('./voice-manager').SavedVoice) => v.id === params.voiceId);
          const backupPath = voice?.enhanced?.originalBackupPath;
          if (!backupPath || !fs.existsSync(backupPath)) {
            throw new Error('Original backup not found. Cannot edit enhancement.');
          }
          inputPath = backupPath;
        } else {
          // First-time enhance: source from the current voice file
          const filePath = voiceManager.getVoiceFilePath(params.voiceId);
          if (!filePath || !fs.existsSync(filePath)) {
            throw new Error('Voice file not found');
          }
          inputPath = filePath;
        }
      } else if (params.audioData) {
        // Enhance uploaded audio (not yet saved)
        const tmpId = randomUUID();
        inputPath = path.join(os.tmpdir(), `pocket-tts-enhance-${tmpId}-input.wav`);
        fs.writeFileSync(inputPath, Buffer.from(params.audioData));
        tempInputCreated = true;
      } else {
        throw new Error('Either voiceId or audioData must be provided');
      }

      try {
        const result = await voiceEnhancer.enhancePreview(
          inputPath,
          { denoise: params.denoise, rmsTargetDb: params.rmsTargetDb },
          (status, details) => {
            // Forward progress to renderer
            if (!sender.isDestroyed()) {
              sender.send('enhance:progress', status, details);
            }
          }
        );

        // Read both files into ArrayBuffers
        const originalBuffer = fs.readFileSync(inputPath);
        const enhancedBuffer = fs.readFileSync(result.tempOutputPath);

        return {
          original: originalBuffer.buffer.slice(
            originalBuffer.byteOffset,
            originalBuffer.byteOffset + originalBuffer.byteLength
          ),
          enhanced: enhancedBuffer.buffer.slice(
            enhancedBuffer.byteOffset,
            enhancedBuffer.byteOffset + enhancedBuffer.byteLength
          ),
        };
      } finally {
        // Clean up temp input if we created it
        if (tempInputCreated) {
          try {
            fs.unlinkSync(inputPath);
          } catch {
            /* ignore */
          }
        }
      }
    }
  );

  // Accept the pending enhancement — commit to permanent storage
  ipcMain.handle(
    'voice:enhance-accept',
    async (
      _event: IpcMainInvokeEvent,
      params: { voiceId: string; rmsTargetDb?: number; denoise?: boolean }
    ): Promise<import('./voice-manager').SavedVoice | null> => {
      const voiceId = typeof params === 'string' ? params : params.voiceId;
      const pending = voiceEnhancer.getPendingResult();
      if (!pending) {
        throw new Error('No pending enhancement to accept');
      }

      const updated = await voiceManager.replaceVoiceFile(voiceId, pending.tempOutputPath, {
        denoise: pending.denoise,
        device: pending.device,
      });

      // Also update audioNormalization metadata with the baked-in RMS value
      if (updated && pending.rmsTargetDb !== undefined) {
        await voiceManager.updateVoiceMetadata(voiceId, {
          audioNormalization: {
            rmsTargetDb: pending.rmsTargetDb,
            denoise: pending.denoise,
          },
        });
      }

      // Clean up temp files
      voiceEnhancer.cleanup();

      // Re-fetch the voice to return the latest metadata
      const voices = await voiceManager.getSavedVoices();
      return voices.find((v: import('./voice-manager').SavedVoice) => v.id === voiceId) ?? updated;
    }
  );

  // Reject the pending enhancement — clean up temp files
  ipcMain.handle('voice:enhance-reject', async () => {
    voiceEnhancer.cleanup();
  });

  // Update audio normalization settings for a voice
  ipcMain.handle(
    'voice:update-normalization',
    async (
      _event: IpcMainInvokeEvent,
      params: { voiceId: string; rmsTargetDb: number; denoise: boolean }
    ): Promise<import('./voice-manager').SavedVoice | null> => {
      return voiceManager.updateVoiceMetadata(params.voiceId, {
        audioNormalization: {
          rmsTargetDb: params.rmsTargetDb,
          denoise: params.denoise,
        },
      });
    }
  );

}

// Clean up temp files on app quit
export function cleanupEnhancer(): void {
  voiceEnhancer.cancel();
  voiceEnhancer.cleanup();
}
