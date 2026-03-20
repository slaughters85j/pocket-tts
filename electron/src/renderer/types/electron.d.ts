export interface TTSParams {
  text: string;
  voiceUrl?: string;
  voiceFile?: ArrayBuffer;
  savedVoiceId?: string;
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
}

export interface MultiTTSParams {
  script: string;
  speakers: SpeakerConfig[];
  crossfade_ms?: number;
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
  enhancePreview: (params: { voiceId?: string; audioData?: ArrayBuffer; denoise: boolean }) => Promise<{ original: ArrayBuffer; enhanced: ArrayBuffer }>;
  enhanceAccept: (voiceId: string) => Promise<SavedVoice>;
  enhanceReject: () => Promise<void>;
  isEnhanceAvailable: () => Promise<boolean>;
  onEnhanceProgress: (callback: (status: string, details?: Record<string, unknown>) => void) => void;
  // Audio normalization per-voice
  updateVoiceNormalization: (params: { voiceId: string; rmsTargetDb: number; denoise: boolean }) => Promise<SavedVoice>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
