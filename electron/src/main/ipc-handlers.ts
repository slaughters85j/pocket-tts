import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { PythonServer } from './python-server';
import type { VoiceManager } from './voice-manager';

interface TTSParams {
  text: string;
  voiceUrl?: string;
  voiceFile?: ArrayBuffer;
  savedVoiceId?: string;
}

interface SpeakerConfig {
  name: string;
  voice_source: string;
  voice_data: string | null;
  seed: number | null;
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
    const { text, voiceUrl, voiceFile, savedVoiceId } = params;
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
}
