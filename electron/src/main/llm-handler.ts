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

  // Send message — streams LLM tokens to the renderer AND pipelines sentence-by-sentence
  // TTS so audio playback starts as soon as the first sentence is ready.
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

    // --- Sentence-streamed TTS pipeline -----------------------------------------------
    // The TTS server is single-flight (not thread-safe, batch=1), so we serialize
    // sentence requests through a single chained Promise. The first sentence's WAV
    // header passes through to the renderer; sentence 2+ have their 44-byte header
    // stripped so the renderer's StreamingWavPlayer keeps treating it as one stream.

    let textBuffer = '';
    const ttsQueue: string[] = [];
    let queuePromise: Promise<void> = Promise.resolve();
    let wavHeaderSent = false;
    let firstAudioLogged = false;
    let totalSentencesSent = 0;
    const overallStartTime = performance.now();

    const extractNextSentence = (): string | null => {
      // Sentence-ending punctuation followed by whitespace, after at least 20 chars
      // (avoids splitting on abbreviations like "Dr." or "e.g.").
      const MIN_LEN = 20;
      for (let i = MIN_LEN; i < textBuffer.length - 1; i++) {
        const ch = textBuffer[i];
        if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(textBuffer[i + 1])) {
          const sentence = textBuffer.slice(0, i + 1).trim();
          textBuffer = textBuffer.slice(i + 1).replace(/^\s+/, '');
          return sentence || null;
        }
      }
      // Fallback: hard newline past min length (paragraph / list-item break).
      const nl = textBuffer.indexOf('\n');
      if (nl >= MIN_LEN) {
        const sentence = textBuffer.slice(0, nl).trim();
        textBuffer = textBuffer.slice(nl + 1).replace(/^\s+/, '');
        return sentence || null;
      }
      return null;
    };

    const streamSentenceTTS = async (text: string): Promise<void> => {
      if (abortController.signal.aborted) return;

      const ttsAbort = new AbortController();
      currentTTSAbort = ttsAbort;
      const onParentAbort = () => ttsAbort.abort();
      abortController.signal.addEventListener('abort', onParentAbort);

      const sentenceStart = performance.now();
      const sentenceIdx = ++totalSentencesSent;

      try {
        const formData = new FormData();
        formData.append('text', text);
        if (voiceWavPath && fs.existsSync(voiceWavPath)) {
          const buf = fs.readFileSync(voiceWavPath);
          formData.append('voice_wav', new Blob([buf], { type: 'audio/wav' }), 'voice.wav');
        } else {
          formData.append('voice_url', resolvedVoiceUrl);
        }

        const ttsResponse = await fetch(`http://127.0.0.1:${LAUNCH_AGENT_TTS_PORT}/tts`, {
          method: 'POST',
          body: formData,
          signal: ttsAbort.signal,
        });

        if (!ttsResponse.ok) {
          const errText = await ttsResponse.text();
          throw new Error(`TTS server error: ${ttsResponse.status} - ${errText}`);
        }

        const reader = ttsResponse.body?.getReader();
        if (!reader) throw new Error('No TTS response body');

        const skipHeader = wavHeaderSent;
        let bytesFromSentence = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || sender.isDestroyed()) continue;

          let chunk: Uint8Array = value;
          // Strip 44-byte WAV header for sentence 2+ so the renderer sees one continuous PCM stream
          if (skipHeader && bytesFromSentence < 44) {
            const toSkip = 44 - bytesFromSentence;
            bytesFromSentence += value.length;
            if (value.length <= toSkip) continue;
            chunk = value.slice(toSkip);
          } else {
            bytesFromSentence += value.length;
          }
          if (chunk.length === 0) continue;

          sender.send('chat:tts-chunk', chunk.slice().buffer);
          wavHeaderSent = true;

          if (!firstAudioLogged) {
            const ttfa = ((performance.now() - overallStartTime) / 1000).toFixed(2);
            console.log(`${LOG_PREFIX} First audio chunk — TTFA: ${ttfa}s`);
            firstAudioLogged = true;
          }
        }

        const dur = ((performance.now() - sentenceStart) / 1000).toFixed(2);
        console.log(`${LOG_PREFIX} Sentence ${sentenceIdx} done (${text.length} chars in ${dur}s)`);
      } finally {
        abortController.signal.removeEventListener('abort', onParentAbort);
        if (currentTTSAbort === ttsAbort) currentTTSAbort = null;
      }
    };

    const drainQueue = async (): Promise<void> => {
      while (ttsQueue.length > 0 && !abortController.signal.aborted) {
        const s = ttsQueue.shift();
        if (s) await streamSentenceTTS(s);
      }
    };

    const enqueueSentence = (s: string): void => {
      const trimmed = s.trim();
      if (!trimmed) return;
      ttsQueue.push(trimmed);
      queuePromise = queuePromise.then(drainQueue).catch((err) => {
        console.error(`${LOG_PREFIX} TTS queue error:`, err instanceof Error ? err.message : err);
      });
    };

    try {
      // --- Stream LLM response: tokens go to renderer immediately, completed
      // sentences get enqueued for TTS in parallel ---

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

      console.log(`${LOG_PREFIX} LLM stream started — voice: ${voiceWavPath ? `saved ${voiceWavPath}` : resolvedVoiceUrl}`);
      const llmStartTime = performance.now();

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No LLM response body');

      const decoder = new TextDecoder();
      let sseBuffer = '';
      let totalLLMChars = 0;

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
              textBuffer += content;
              totalLLMChars += content.length;

              // Flush any complete sentences into the TTS queue
              let sentence: string | null;
              while ((sentence = extractNextSentence()) !== null) {
                enqueueSentence(sentence);
              }
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }

      const llmDuration = ((performance.now() - llmStartTime) / 1000).toFixed(2);
      console.log(`${LOG_PREFIX} LLM stream complete — ${totalLLMChars} chars in ${llmDuration}s`);

      // Flush remaining buffered text as the final sentence
      if (textBuffer.trim()) {
        enqueueSentence(textBuffer);
        textBuffer = '';
      }

      if (totalSentencesSent === 0 && ttsQueue.length === 0) {
        console.log(`${LOG_PREFIX} Empty LLM response, skipping TTS`);
        if (!sender.isDestroyed()) {
          sender.send('chat:complete');
        }
        return;
      }

      // Wait for the TTS queue to fully drain before signaling completion
      await queuePromise;

      const totalDur = ((performance.now() - overallStartTime) / 1000).toFixed(2);
      console.log(`${LOG_PREFIX} All TTS done — ${totalSentencesSent} sentences in ${totalDur}s`);

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
