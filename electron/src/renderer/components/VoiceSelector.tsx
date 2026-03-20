import React from 'react';

export const PREDEFINED_VOICES = [
  { id: 'alba', name: 'Alba', description: 'Female, casual' },
  { id: 'marius', name: 'Marius', description: 'Male' },
  { id: 'javert', name: 'Javert', description: 'Male' },
  { id: 'jean', name: 'Jean', description: 'Male' },
  { id: 'fantine', name: 'Fantine', description: 'Female' },
  { id: 'cosette', name: 'Cosette', description: 'Female, expressive' },
  { id: 'eponine', name: 'Eponine', description: 'Female' },
  { id: 'azelma', name: 'Azelma', description: 'Female' },
];

export interface SavedVoice {
  id: string;
  name: string;
  description: string;
  filePath: string;
  createdAt: string;
  enhanced?: {
    enhancedAt: string;
    denoise: boolean;
    device: string;
    originalBackupPath?: string;
  };
  audioNormalization?: {
    rmsTargetDb: number;
    denoise: boolean;
  };
}

interface VoiceSelectorProps {
  selectedVoice: string;
  onVoiceChange: (voice: string) => void;
  hasCustomAudio?: boolean;
  disabled?: boolean;
  savedVoices?: SavedVoice[];
  onDeleteSavedVoice?: (id: string) => void;
  onEnhanceVoice?: (id: string) => void;
  enhanceAvailable?: boolean;
}

export function VoiceSelector({
  selectedVoice,
  onVoiceChange,
  hasCustomAudio,
  disabled,
  savedVoices = [],
  onDeleteSavedVoice,
  onEnhanceVoice,
  enhanceAvailable = false,
}: VoiceSelectorProps) {
  const selectedSavedVoice = selectedVoice.startsWith('saved:')
    ? savedVoices.find((v) => v.id === selectedVoice.replace('saved:', ''))
    : null;

  return (
    <div className="bg-bg-secondary rounded-lg p-4">
      <label className="block text-sm font-medium text-text-primary mb-3">
        Voice
      </label>
      <select
        value={selectedVoice}
        onChange={(e) => onVoiceChange(e.target.value)}
        disabled={disabled}
        className={`w-full bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-4 py-3 text-sm
          focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <optgroup label="Built-in Voices">
          {PREDEFINED_VOICES.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name} - {voice.description}
            </option>
          ))}
        </optgroup>
        {savedVoices.length > 0 && (
          <optgroup label="My Saved Voices">
            {savedVoices.map((voice) => (
              <option key={`saved:${voice.id}`} value={`saved:${voice.id}`}>
                {voice.enhanced ? '\u2728 ' : ''}{voice.name}{voice.description ? ` - ${voice.description}` : ''}
              </option>
            ))}
          </optgroup>
        )}
        {hasCustomAudio && (
          <optgroup label="Current Session">
            <option value="custom">Custom (uploaded audio)</option>
          </optgroup>
        )}
      </select>
      <p className="mt-2 text-xs text-text-secondary">
        Select a pre-made voice or upload custom audio above for voice cloning.
      </p>

      {/* Actions for saved voices */}
      {selectedVoice.startsWith('saved:') && (
        <div className="mt-2 flex items-center gap-3">
          {/* Enhanced badge */}
          {selectedSavedVoice?.enhanced && (
            <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">
              Enhanced
            </span>
          )}

          {/* Enhance button */}
          {enhanceAvailable && onEnhanceVoice && (
            <button
              onClick={() => onEnhanceVoice(selectedVoice.replace('saved:', ''))}
              disabled={disabled}
              className="text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
            >
              {selectedSavedVoice?.enhanced ? 'Re-enhance' : 'Enhance with LavaSR'}
            </button>
          )}

          {/* Delete button */}
          {onDeleteSavedVoice && (
            <button
              onClick={() => onDeleteSavedVoice(selectedVoice.replace('saved:', ''))}
              disabled={disabled}
              className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
