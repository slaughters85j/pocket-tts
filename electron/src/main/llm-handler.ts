import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import type { PythonServer } from './python-server';

const LM_STUDIO_BASE = 'http://192.168.50.254:1234';
const LM_STUDIO_CHAT = `${LM_STUDIO_BASE}/v1/chat/completions`;
const LM_STUDIO_MODELS = `${LM_STUDIO_BASE}/v1/models`;
const CONNECTION_TIMEOUT_MS = 3000;

// Use the LaunchAgent TTS server (port 8765) — it's warm with cached model
// weights and voice states, giving ~3-6s TTFA vs ~17s on the cold Electron server.
const LAUNCH_AGENT_TTS_PORT = 8765;

const LOG_PREFIX = '[ChatLLM]';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatSendParams {
  messages: ChatMessage[];
  voiceUrl?: string;
  savedVoiceId?: string;
}

// --- IPC Registration ---

let currentChatAbort: AbortController | null = null;
let currentTTSAbort: AbortController | null = null;

export function registerChatHandlers(
  _getPythonServer: () => PythonServer | null,
  voiceManager: { getVoiceFilePath: (id: string) => string | null },
) {
  // Health check — GET /v1/models from LM Studio
  ipcMain.handle('chat:check-connection', async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

      const response = await fetch(LM_STUDIO_MODELS, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        console.log(`${LOG_PREFIX} Connection check failed: HTTP ${response.status}`);
        return { connected: false };
      }

      const data = await response.json();
      const model = data?.data?.[0]?.id || null;
      console.log(`${LOG_PREFIX} Connected to LM Studio, model: ${model}`);
      return { connected: true, model };
    } catch (error) {
      console.log(`${LOG_PREFIX} Connection check failed:`, error instanceof Error ? error.message : error);
      return { connected: false };
    }
  });

  // Cancel in-flight chat + TTS
  ipcMain.handle('chat:cancel', async () => {
    console.log(`${LOG_PREFIX} Cancel requested`);
    if (currentChatAbort) {
      currentChatAbort.abort();
      currentChatAbort = null;
    }
    if (currentTTSAbort) {
      currentTTSAbort.abort();
      currentTTSAbort = null;
    }
  });

  // Send message — streams LLM response for live text, then sends full text to TTS in one shot
  ipcMain.handle('chat:send-message', async (event: IpcMainInvokeEvent, params: ChatSendParams) => {
    const { messages, voiceUrl, savedVoiceId } = params;
    const sender = event.sender;

    console.log(`${LOG_PREFIX} Send message — ${messages.length} messages, voice: ${voiceUrl || savedVoiceId || 'default'}`);

    // Cancel any previous chat/TTS
    if (currentChatAbort) {
      currentChatAbort.abort();
    }
    if (currentTTSAbort) {
      currentTTSAbort.abort();
    }

    const abortController = new AbortController();
    currentChatAbort = abortController;

    // Resolve voice
    const resolvedVoiceUrl = voiceUrl || 'alba';
    let voiceWavPath: string | null = null;
    if (savedVoiceId) {
      voiceWavPath = voiceManager.getVoiceFilePath(savedVoiceId);
    }

    let fullResponseText = '';

    try {
      // --- Phase 1: Stream LLM response (tokens sent to renderer for live display) ---

      const response = await fetch(LM_STUDIO_CHAT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          stream: true,
          temperature: 0.7,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LM Studio error: ${response.status} - ${errorText}`);
      }

      console.log(`${LOG_PREFIX} LLM stream started`);
      const llmStartTime = performance.now();

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No LLM response body');

      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || ''; // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              // Send token to renderer for live text display
              if (!sender.isDestroyed()) {
                sender.send('chat:llm-chunk', content);
              }
              fullResponseText += content;
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }

      const llmDuration = ((performance.now() - llmStartTime) / 1000).toFixed(2);
      console.log(`${LOG_PREFIX} LLM stream complete — ${fullResponseText.length} chars in ${llmDuration}s`);

      if (!fullResponseText.trim()) {
        console.log(`${LOG_PREFIX} Empty LLM response, skipping TTS`);
        if (!sender.isDestroyed()) {
          sender.send('chat:complete');
        }
        return;
      }

      // --- Phase 2: Send full response to TTS in one shot (like Quick Action) ---

      const ttsAbort = new AbortController();
      currentTTSAbort = ttsAbort;

      console.log(`${LOG_PREFIX} TTS starting — sending ${fullResponseText.length} chars to LaunchAgent :${LAUNCH_AGENT_TTS_PORT}`);
      const ttsStartTime = performance.now();

      const formData = new FormData();
      formData.append('text', fullResponseText);

      if (voiceWavPath && fs.existsSync(voiceWavPath)) {
        const buffer = fs.readFileSync(voiceWavPath);
        const blob = new Blob([buffer], { type: 'audio/wav' });
        formData.append('voice_wav', blob, 'voice.wav');
        console.log(`${LOG_PREFIX} Using saved voice: ${voiceWavPath}`);
      } else {
        formData.append('voice_url', resolvedVoiceUrl);
        console.log(`${LOG_PREFIX} Using voice: ${resolvedVoiceUrl}`);
      }

      const ttsResponse = await fetch(`http://127.0.0.1:${LAUNCH_AGENT_TTS_PORT}/tts`, {
        method: 'POST',
        body: formData,
        signal: ttsAbort.signal,
      });

      if (!ttsResponse.ok) {
        const errorText = await ttsResponse.text();
        throw new Error(`TTS server error: ${ttsResponse.status} - ${errorText}`);
      }

      const ttsReader = ttsResponse.body?.getReader();
      if (!ttsReader) throw new Error('No TTS response body');

      let ttsChunks = 0;
      let ttsBytes = 0;
      let firstChunkLogged = false;

      while (true) {
        const { done, value } = await ttsReader.read();
        if (done) break;

        if (value && !sender.isDestroyed()) {
          sender.send('chat:tts-chunk', value.buffer);
          ttsChunks++;
          ttsBytes += value.length;

          if (!firstChunkLogged) {
            const ttfa = ((performance.now() - ttsStartTime) / 1000).toFixed(2);
            console.log(`${LOG_PREFIX} TTS first chunk received — TTFA: ${ttfa}s`);
            firstChunkLogged = true;
          }
        }
      }

      const ttsDuration = ((performance.now() - ttsStartTime) / 1000).toFixed(2);
      console.log(`${LOG_PREFIX} TTS complete — ${ttsBytes} bytes in ${ttsChunks} chunks (${ttsDuration}s)`);

      if (!sender.isDestroyed()) {
        sender.send('chat:tts-sentence-complete');
        sender.send('chat:complete');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log(`${LOG_PREFIX} Chat cancelled by user`);
        if (!sender.isDestroyed()) {
          sender.send('chat:complete');
        }
      } else {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`${LOG_PREFIX} Error:`, msg);
        if (!sender.isDestroyed()) {
          sender.send('chat:error', msg);
        }
      }
    } finally {
      if (currentChatAbort === abortController) {
        currentChatAbort = null;
      }
      currentTTSAbort = null;
    }
  });
}
