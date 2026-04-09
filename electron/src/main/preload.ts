import { contextBridge, ipcRenderer } from 'electron';

export interface TTSParams {
  text: string;
  voiceUrl?: string;
  voiceFile?: ArrayBuffer;
  savedVoiceId?: string;
  rmsTargetDb?: number;
  // Fish-speech generation params (ignored by pocket-tts)
  fishTemperature?: number;
  fishTopP?: number;
  fishTopK?: number;
}

export interface EnhancementMeta {
  enhancedAt: string;
  denoise: boolean;
  device: string;
  originalBackupPath?: string;
}

export interface AudioNormalization {
  rmsTargetDb: number;
  denoise: boolean;
}

export interface SavedVoice {
  id: string;
  name: string;
  description: string;
  filePath: string;
  createdAt: string;
  enhanced?: EnhancementMeta;
  audioNormalization?: AudioNormalization;
}

export interface SpeakerConfig {
  name: string;
  voice_source: string;
  voice_data: string | null;
  seed: number | null;
  rms_target_db?: number;
}

export interface MultiTTSParams {
  script: string;
  speakers: SpeakerConfig[];
  crossfade_ms?: number;
  fishTemperature?: number;
  fishTopP?: number;
  fishTopK?: number;
}

export interface ElectronAPI {
  getServerPort: () => Promise<number>;
  generateTTS: (params: TTSParams) => Promise<void>;
  generateMultiTTS: (params: MultiTTSParams) => Promise<void>;
  cancelTTS: () => Promise<void>;
  onTTSChunk: (callback: (chunk: ArrayBuffer) => void) => void;
  onTTSComplete: (callback: () => void) => void;
  onTTSCancelled: (callback: () => void) => void;
  onTTSError: (callback: (error: string) => void) => void;
  onTTSStatus: (callback: (message: string) => void) => void;
  removeAllListeners: () => void;
  // Voice management
  saveVoice: (params: { name: string; description: string; audioData: ArrayBuffer }) => Promise<SavedVoice>;
  getSavedVoices: () => Promise<SavedVoice[]>;
  deleteVoice: (id: string) => Promise<void>;
  // Dev tools
  toggleDevTools: () => Promise<void>;
  // Audio conversion
  convertToM4a: (wavBuffer: ArrayBuffer) => Promise<ArrayBuffer>;
  isM4aAvailable: () => Promise<boolean>;
  // Voice enhancement
  enhancePreview: (params: {
    voiceId?: string;
    audioData?: ArrayBuffer;
    denoise: boolean;
    rmsTargetDb?: number;
    useOriginalBackup?: boolean;
  }) => Promise<{ original: ArrayBuffer; enhanced: ArrayBuffer }>;
  enhanceAccept: (params: { voiceId: string; rmsTargetDb?: number; denoise?: boolean }) => Promise<SavedVoice>;
  enhanceReject: () => Promise<void>;
  isEnhanceAvailable: () => Promise<'ready' | 'needs-setup' | 'unavailable'>;
  onEnhanceProgress: (callback: (status: string, details?: Record<string, unknown>) => void) => void;
  // LavaSR venv bootstrap
  setupEnhance: () => Promise<void>;
  cancelEnhanceSetup: () => Promise<void>;
  onSetupProgress: (callback: (status: string, details?: Record<string, unknown>) => void) => void;
  // Audio normalization per-voice
  updateVoiceNormalization: (params: { voiceId: string; rmsTargetDb: number; denoise: boolean }) => Promise<SavedVoice>;
  // Backend management
  getBackends: () => Promise<{ available: string[]; active: string | null; supports_tags: boolean }>;
  switchBackend: (name: string) => Promise<{ status: string; backend?: string; message?: string }>;
  // Chat LLM
  chatSendMessage: (params: {
    messages: { role: string; content: string }[];
    voiceUrl?: string;
    savedVoiceId?: string;
  }) => Promise<void>;
  chatCancel: () => Promise<void>;
  chatCheckConnection: () => Promise<{ connected: boolean; model?: string }>;
  onChatLLMChunk: (callback: (text: string) => void) => void;
  onChatTTSChunk: (callback: (chunk: ArrayBuffer) => void) => void;
  onChatTTSSentenceComplete: (callback: () => void) => void;
  onChatComplete: (callback: () => void) => void;
  onChatError: (callback: (error: string) => void) => void;
  removeChatListeners: () => void;
  startDictation?: () => Promise<void>;
}

contextBridge.exposeInMainWorld('electronAPI', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  generateTTS: (params: TTSParams) => ipcRenderer.invoke('tts:generate', params),
  generateMultiTTS: (params: MultiTTSParams) => ipcRenderer.invoke('tts:generate-multi', params),
  cancelTTS: () => ipcRenderer.invoke('tts:cancel'),
  onTTSChunk: (callback: (chunk: ArrayBuffer) => void) => {
    ipcRenderer.on('tts:chunk', (_event, chunk) => callback(chunk));
  },
  onTTSComplete: (callback: () => void) => {
    ipcRenderer.on('tts:complete', () => callback());
  },
  onTTSCancelled: (callback: () => void) => {
    ipcRenderer.on('tts:cancelled', () => callback());
  },
  onTTSError: (callback: (error: string) => void) => {
    ipcRenderer.on('tts:error', (_event, error) => callback(error));
  },
  onTTSStatus: (callback: (message: string) => void) => {
    ipcRenderer.on('tts:status', (_event, message) => callback(message));
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('tts:chunk');
    ipcRenderer.removeAllListeners('tts:complete');
    ipcRenderer.removeAllListeners('tts:cancelled');
    ipcRenderer.removeAllListeners('tts:error');
    ipcRenderer.removeAllListeners('tts:status');
  },
  // Voice management
  saveVoice: (params: { name: string; description: string; audioData: ArrayBuffer }) =>
    ipcRenderer.invoke('voice:save', params),
  getSavedVoices: () => ipcRenderer.invoke('voice:list'),
  deleteVoice: (id: string) => ipcRenderer.invoke('voice:delete', id),
  // Dev tools
  toggleDevTools: () => ipcRenderer.invoke('toggle-devtools'),
  // Audio conversion
  convertToM4a: (wavBuffer: ArrayBuffer) => ipcRenderer.invoke('audio:convert-to-m4a', wavBuffer),
  isM4aAvailable: () => ipcRenderer.invoke('audio:m4a-available'),
  // Voice enhancement
  enhancePreview: (params: {
    voiceId?: string;
    audioData?: ArrayBuffer;
    denoise: boolean;
    rmsTargetDb?: number;
    useOriginalBackup?: boolean;
  }) => ipcRenderer.invoke('voice:enhance-preview', params),
  enhanceAccept: (params: { voiceId: string; rmsTargetDb?: number; denoise?: boolean }) =>
    ipcRenderer.invoke('voice:enhance-accept', params),
  enhanceReject: () => ipcRenderer.invoke('voice:enhance-reject'),
  isEnhanceAvailable: () => ipcRenderer.invoke('voice:enhance-available'),
  onEnhanceProgress: (callback: (status: string, details?: Record<string, unknown>) => void) => {
    ipcRenderer.on('enhance:progress', (_event, status, details) => callback(status, details));
  },
  // LavaSR venv bootstrap
  setupEnhance: () => ipcRenderer.invoke('voice:enhance-setup'),
  cancelEnhanceSetup: () => ipcRenderer.invoke('voice:enhance-setup-cancel'),
  onSetupProgress: (callback: (status: string, details?: Record<string, unknown>) => void) => {
    ipcRenderer.on('enhance:setup-progress', (_event, status, details) => callback(status, details));
  },
  // Audio normalization per-voice
  updateVoiceNormalization: (params: { voiceId: string; rmsTargetDb: number; denoise: boolean }) =>
    ipcRenderer.invoke('voice:update-normalization', params),
  // Backend management
  getBackends: () => ipcRenderer.invoke('backend:list'),
  switchBackend: (name: string) => ipcRenderer.invoke('backend:switch', name),
  // Chat LLM
  chatSendMessage: (params: {
    messages: { role: string; content: string }[];
    voiceUrl?: string;
    savedVoiceId?: string;
  }) => ipcRenderer.invoke('chat:send-message', params),
  chatCancel: () => ipcRenderer.invoke('chat:cancel'),
  chatCheckConnection: () => ipcRenderer.invoke('chat:check-connection'),
  onChatLLMChunk: (callback: (text: string) => void) => {
    ipcRenderer.on('chat:llm-chunk', (_event, text) => callback(text));
  },
  onChatTTSChunk: (callback: (chunk: ArrayBuffer) => void) => {
    ipcRenderer.on('chat:tts-chunk', (_event, chunk) => callback(chunk));
  },
  onChatTTSSentenceComplete: (callback: () => void) => {
    ipcRenderer.on('chat:tts-sentence-complete', () => callback());
  },
  onChatComplete: (callback: () => void) => {
    ipcRenderer.on('chat:complete', () => callback());
  },
  onChatError: (callback: (error: string) => void) => {
    ipcRenderer.on('chat:error', (_event, error) => callback(error));
  },
  startDictation: () => ipcRenderer.invoke('start-dictation'),
  removeChatListeners: () => {
    ipcRenderer.removeAllListeners('chat:llm-chunk');
    ipcRenderer.removeAllListeners('chat:tts-chunk');
    ipcRenderer.removeAllListeners('chat:tts-sentence-complete');
    ipcRenderer.removeAllListeners('chat:complete');
    ipcRenderer.removeAllListeners('chat:error');
  },
} as ElectronAPI);
