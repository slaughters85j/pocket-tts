import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

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

interface VoicesData {
  voices: SavedVoice[];
}

class VoiceManager {
  private voicesDir: string;
  private metadataPath: string;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.voicesDir = path.join(userDataPath, 'voices');
    this.metadataPath = path.join(userDataPath, 'voices.json');
    this.ensureVoicesDir();
  }

  private ensureVoicesDir(): void {
    if (!fs.existsSync(this.voicesDir)) {
      fs.mkdirSync(this.voicesDir, { recursive: true });
    }
  }

  private loadMetadata(): VoicesData {
    try {
      if (fs.existsSync(this.metadataPath)) {
        const data = fs.readFileSync(this.metadataPath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load voices metadata:', error);
    }
    return { voices: [] };
  }

  private saveMetadata(data: VoicesData): void {
    fs.writeFileSync(this.metadataPath, JSON.stringify(data, null, 2));
  }

  async saveVoice(name: string, description: string, audioData: ArrayBuffer): Promise<SavedVoice> {
    const id = randomUUID();
    const fileName = `${id}.wav`;
    const filePath = path.join(this.voicesDir, fileName);

    // Write the audio file
    const buffer = Buffer.from(audioData);
    fs.writeFileSync(filePath, buffer);

    // Create the voice entry
    const voice: SavedVoice = {
      id,
      name,
      description,
      filePath,
      createdAt: new Date().toISOString(),
    };

    // Update metadata
    const data = this.loadMetadata();
    data.voices.push(voice);
    this.saveMetadata(data);

    console.log(`Saved voice "${name}" to ${filePath}`);
    return voice;
  }

  async getSavedVoices(): Promise<SavedVoice[]> {
    const data = this.loadMetadata();
    // Filter out voices whose files no longer exist
    const validVoices = data.voices.filter((voice) => fs.existsSync(voice.filePath));
    if (validVoices.length !== data.voices.length) {
      data.voices = validVoices;
      this.saveMetadata(data);
    }
    return validVoices;
  }

  async deleteVoice(id: string): Promise<void> {
    const data = this.loadMetadata();
    const voice = data.voices.find((v) => v.id === id);

    if (voice) {
      // Delete the audio file
      if (fs.existsSync(voice.filePath)) {
        fs.unlinkSync(voice.filePath);
      }

      // Remove from metadata
      data.voices = data.voices.filter((v) => v.id !== id);
      this.saveMetadata(data);

      console.log(`Deleted voice "${voice.name}"`);
    }
  }

  getVoiceFilePath(id: string): string | null {
    const data = this.loadMetadata();
    const voice = data.voices.find((v) => v.id === id);
    return voice?.filePath ?? null;
  }

  async getVoiceAudioBuffer(id: string): Promise<Buffer | null> {
    const filePath = this.getVoiceFilePath(id);
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath);
  }

  async updateVoiceMetadata(id: string, updates: Partial<SavedVoice>): Promise<SavedVoice | null> {
    const data = this.loadMetadata();
    const index = data.voices.findIndex((v) => v.id === id);
    if (index === -1) return null;

    // Merge updates (don't allow changing id or filePath via this method)
    const { id: _id, filePath: _fp, ...safeUpdates } = updates;
    data.voices[index] = { ...data.voices[index], ...safeUpdates };
    this.saveMetadata(data);

    return data.voices[index];
  }

  /**
   * Replace a voice's audio file with an enhanced version.
   * Backs up the original file before replacement.
   */
  async replaceVoiceFile(
    id: string,
    newFilePath: string,
    enhancementMeta: Omit<EnhancementMeta, 'originalBackupPath' | 'enhancedAt'>
  ): Promise<SavedVoice | null> {
    const data = this.loadMetadata();
    const voice = data.voices.find((v) => v.id === id);
    if (!voice) return null;

    // Create backup directory
    const backupDir = path.join(path.dirname(this.voicesDir), 'voices_backup');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Backup original file
    const originalBackupPath = path.join(backupDir, `${id}-original.wav`);
    if (fs.existsSync(voice.filePath)) {
      fs.copyFileSync(voice.filePath, originalBackupPath);
    }

    // Copy enhanced file to the voice's permanent location
    fs.copyFileSync(newFilePath, voice.filePath);

    // Update metadata with enhancement info
    const enhanced: EnhancementMeta = {
      enhancedAt: new Date().toISOString(),
      denoise: enhancementMeta.denoise,
      device: enhancementMeta.device,
      originalBackupPath,
    };

    const index = data.voices.findIndex((v) => v.id === id);
    data.voices[index] = { ...data.voices[index], enhanced };
    this.saveMetadata(data);

    console.log(`Enhanced voice "${voice.name}" (backup at ${originalBackupPath})`);
    return data.voices[index];
  }
}

let voiceManager: VoiceManager | null = null;

export function getVoiceManager(): VoiceManager {
  if (!voiceManager) {
    voiceManager = new VoiceManager();
  }
  return voiceManager;
}

export function registerVoiceHandlers(): void {
  const manager = getVoiceManager();

  ipcMain.handle('voice:save', async (_event, params: { name: string; description: string; audioData: ArrayBuffer }) => {
    return manager.saveVoice(params.name, params.description, params.audioData);
  });

  ipcMain.handle('voice:list', async () => {
    return manager.getSavedVoices();
  });

  ipcMain.handle('voice:delete', async (_event, id: string) => {
    return manager.deleteVoice(id);
  });
}
