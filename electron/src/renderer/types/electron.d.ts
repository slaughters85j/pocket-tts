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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
