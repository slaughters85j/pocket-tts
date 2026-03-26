import React, { useState, useCallback, useRef, useEffect } from 'react';
import { VoiceSelector, SavedVoice } from './VoiceSelector';
import { StreamingWavPlayer } from '../lib/streaming-wav-player';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatLLMProps {
  savedVoices: SavedVoice[];
  onDeleteSavedVoice?: (id: string) => void;
}

type ConnectionStatus = 'checking' | 'connected' | 'disconnected';

export function ChatLLM({ savedVoices, onDeleteSavedVoice }: ChatLLMProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('alba');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const [connectedModel, setConnectedModel] = useState<string | null>(null);
  const [currentAssistantText, setCurrentAssistantText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const playerRef = useRef<StreamingWavPlayer | null>(null);
  const isStreamingRef = useRef(false);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentAssistantText]);

  // Connection health check — on mount and every 30s
  const checkConnection = useCallback(async () => {
    try {
      const result = await window.electronAPI.chatCheckConnection();
      setConnectionStatus(result.connected ? 'connected' : 'disconnected');
      setConnectedModel(result.model || null);
    } catch {
      setConnectionStatus('disconnected');
      setConnectedModel(null);
    }
  }, []);

  useEffect(() => {
    checkConnection();
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, [checkConnection]);

  // Set up IPC listeners
  useEffect(() => {
    // Clean up previous listeners
    window.electronAPI.removeChatListeners();

    window.electronAPI.onChatLLMChunk((text: string) => {
      setCurrentAssistantText((prev) => prev + text);
    });

    window.electronAPI.onChatTTSChunk((chunk: ArrayBuffer) => {
      playerRef.current?.addChunk(new Uint8Array(chunk));
    });

    window.electronAPI.onChatTTSSentenceComplete(() => {
      // TTS stream finished — flush remaining audio
      playerRef.current?.flushRemaining();
    });

    window.electronAPI.onChatComplete(() => {
      playerRef.current?.flushRemaining();
      setIsStreaming(false);
      isStreamingRef.current = false;
      setCurrentAssistantText((text) => {
        if (text.trim()) {
          setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
        }
        return '';
      });
      setTimeout(() => inputRef.current?.focus(), 50);
    });

    window.electronAPI.onChatError((errorMsg: string) => {
      console.error('[ChatLLM] Error:', errorMsg);
      setError(errorMsg);
      setIsStreaming(false);
      isStreamingRef.current = false;
      setCurrentAssistantText((text) => {
        if (text.trim()) {
          setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
        }
        return '';
      });
      setTimeout(() => inputRef.current?.focus(), 50);
    });

    return () => {
      window.electronAPI.removeChatListeners();
    };
  }, []);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isStreamingRef.current || connectionStatus !== 'connected') return;

    setError(null);
    setIsStreaming(true);
    isStreamingRef.current = true;
    setCurrentAssistantText('');

    // Add user message
    const userMessage: ChatMessage = { role: 'user', content: text };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInputText('');

    // Keep input focused so user can type next message immediately
    setTimeout(() => inputRef.current?.focus(), 0);

    // Create audio player
    playerRef.current?.stop();
    playerRef.current = new StreamingWavPlayer({
      onFirstAudio: () => {},
      onComplete: () => {},
      onError: (err) => {
        console.error('[ChatLLM] Audio playback error:', err);
      },
    });

    // Resolve voice for IPC
    const voiceParams: { voiceUrl?: string; savedVoiceId?: string } = {};
    if (selectedVoice.startsWith('saved:')) {
      voiceParams.savedVoiceId = selectedVoice.replace('saved:', '');
    } else {
      voiceParams.voiceUrl = selectedVoice;
    }

    try {
      await window.electronAPI.chatSendMessage({
        messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
        ...voiceParams,
      });
    } catch (err) {
      console.error('[ChatLLM] Send error:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');
      setIsStreaming(false);
      isStreamingRef.current = false;
    }
  }, [inputText, messages, connectionStatus, selectedVoice]);

  const handleCancel = useCallback(() => {
    window.electronAPI.chatCancel();
    playerRef.current?.stop();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleVoiceChange = useCallback((voice: string) => {
    setSelectedVoice(voice);
  }, []);

  // Connection status dot
  const statusDot = {
    checking: 'bg-yellow-400 animate-pulse',
    connected: 'bg-green-500',
    disconnected: 'bg-red-500',
  }[connectionStatus];

  const statusLabel = {
    checking: 'Checking...',
    connected: connectedModel ? `Connected — ${connectedModel}` : 'Connected',
    disconnected: 'Disconnected',
  }[connectionStatus];

  return (
    <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 180px)' }}>
      {/* Two-Column Layout */}
      <div className="flex gap-6 flex-1 min-h-0">
        {/* Left Column: Connection + Voice */}
        <div className="w-[380px] flex-shrink-0 flex flex-col space-y-4">
          {/* Connection Status */}
          <div className="bg-bg-secondary rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-text-primary">LM Studio</label>
              <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${statusDot}`} />
                <span className="text-xs text-text-secondary">{statusLabel}</span>
              </div>
            </div>

            {/* Service Provider (locked to LM Studio) */}
            <select
              disabled
              className="w-full bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-4 py-3 text-sm
                opacity-60 cursor-not-allowed"
            >
              <option>LM Studio</option>
            </select>
          </div>

          {/* Voice Selector */}
          <VoiceSelector
            selectedVoice={selectedVoice}
            onVoiceChange={handleVoiceChange}
            disabled={isStreaming}
            savedVoices={savedVoices}
            onDeleteSavedVoice={onDeleteSavedVoice}
            hidePredefinedVoices={false}
          />

          {/* Clear Chat */}
          <button
            onClick={() => {
              setMessages([]);
              setCurrentAssistantText('');
              setError(null);
            }}
            disabled={isStreaming || messages.length === 0}
            className={`w-full px-4 py-2 text-sm border border-border-color rounded-lg text-text-secondary
              hover:bg-bg-secondary transition-colors
              ${isStreaming || messages.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Clear Chat
          </button>
        </div>

        {/* Right Column: Chat Area */}
        <div className="flex-1 flex flex-col min-w-0 pb-6">
          <div className="bg-bg-secondary rounded-lg flex flex-col flex-1 overflow-hidden">
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && !currentAssistantText && (
                <div className="flex items-center justify-center h-full text-text-secondary text-sm">
                  <p>Send a message to start chatting. Responses will be spoken aloud.</p>
                </div>
              )}

              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
                      msg.role === 'user'
                        ? 'bg-accent/20 text-text-primary'
                        : 'bg-bg-tertiary text-text-primary'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}

              {/* Streaming assistant message */}
              {currentAssistantText && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-lg px-4 py-3 text-sm bg-bg-tertiary text-text-primary">
                    <p className="whitespace-pre-wrap">
                      {currentAssistantText}
                      <span className="inline-block w-2 h-4 bg-accent/60 animate-pulse ml-0.5 align-text-bottom" />
                    </p>
                  </div>
                </div>
              )}

              {/* Error display */}
              {error && (
                <div className="flex justify-center">
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-sm text-red-400">
                    {error}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <div className="border-t border-border-color p-4">
              <div className="flex gap-3 items-end">
                <textarea
                  ref={inputRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={connectionStatus !== 'connected'}
                  placeholder={
                    connectionStatus !== 'connected'
                      ? 'Connect to LM Studio to chat...'
                      : 'Type a message... (Enter to send, Shift+Enter for newline)'
                  }
                  rows={1}
                  className={`flex-1 bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-4 py-3 text-sm
                    placeholder:text-text-secondary/50 resize-none
                    focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
                    ${isStreaming || connectionStatus !== 'connected' ? 'opacity-50 cursor-not-allowed' : ''}`}
                  style={{ minHeight: '44px', maxHeight: '120px' }}
                />

                {isStreaming ? (
                  <button
                    onClick={handleCancel}
                    className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium
                      transition-colors flex-shrink-0"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!inputText.trim() || connectionStatus !== 'connected'}
                    className={`px-4 py-3 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium
                      transition-colors flex-shrink-0
                      ${!inputText.trim() || connectionStatus !== 'connected' ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
