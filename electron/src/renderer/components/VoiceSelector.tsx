import React, { useState, useCallback } from 'react';

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

type EnhanceStatus = 'ready' | 'needs-setup' | 'unavailable';

interface VoiceSelectorProps {
  selectedVoice: string;
  onVoiceChange: (voice: string) => void;
  hasCustomAudio?: boolean;
  disabled?: boolean;
  savedVoices?: SavedVoice[];
  onDeleteSavedVoice?: (id: string) => void;
  onEnhanceVoice?: (id: string) => void;
  onEditEnhancement?: (id: string) => void;
  enhanceStatus?: EnhanceStatus;
  onEnhanceStatusChange?: (status: EnhanceStatus) => void;
  hidePredefinedVoices?: boolean;
}

export function VoiceSelector({
  selectedVoice,
  onVoiceChange,
  hasCustomAudio,
  disabled,
  savedVoices = [],
  onDeleteSavedVoice,
  onEnhanceVoice,
  onEditEnhancement,
  enhanceStatus = 'unavailable',
  onEnhanceStatusChange,
  hidePredefinedVoices = false,
}: VoiceSelectorProps) {
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [setupMessage, setSetupMessage] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);

  const selectedSavedVoice = selectedVoice.startsWith('saved:')
    ? savedVoices.find((v) => v.id === selectedVoice.replace('saved:', ''))
    : null;

  const handleSetup = useCallback(async () => {
    setIsSettingUp(true);
    setSetupMessage('Starting LavaSR setup...');
    setSetupError(null);

    // Listen for progress
    window.electronAPI?.onSetupProgress((_status: string, details?: Record<string, unknown>) => {
      if (details?.message) {
        setSetupMessage(details.message as string);
      }
    });

    try {
      await window.electronAPI.setupEnhance();
      onEnhanceStatusChange?.('ready');
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'LavaSR setup failed');
    } finally {
      setIsSettingUp(false);
      setSetupMessage('');
    }
  }, [onEnhanceStatusChange]);

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
        {!hidePredefinedVoices && (
        <optgroup label="Built-in Voices">
          {[...PREDEFINED_VOICES].sort((a, b) => a.name.localeCompare(b.name)).map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name} - {voice.description}
            </option>
          ))}
        </optgroup>
        )}
        {savedVoices.length > 0 && (
          <optgroup label="My Saved Voices">
            {[...savedVoices].sort((a, b) => a.name.localeCompare(b.name)).map((voice) => (
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
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-3">
            {/* Enhanced badge with RMS level */}
            {selectedSavedVoice?.enhanced && (
              <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">
                Enhanced{selectedSavedVoice.audioNormalization?.rmsTargetDb != null
                  ? ` (${selectedSavedVoice.audioNormalization.rmsTargetDb} dB)`
                  : ''}
              </span>
            )}

            {/* Enhance / Edit Enhancement button — ready */}
            {enhanceStatus === 'ready' && (
              <>
                {selectedSavedVoice?.enhanced && onEditEnhancement && (
                  <button
                    onClick={() => onEditEnhancement(selectedVoice.replace('saved:', ''))}
                    disabled={disabled}
                    className="text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
                  >
                    Edit Enhancement
                  </button>
                )}
                {!selectedSavedVoice?.enhanced && onEnhanceVoice && (
                  <button
                    onClick={() => onEnhanceVoice(selectedVoice.replace('saved:', ''))}
                    disabled={disabled}
                    className="text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
                  >
                    Enhance with LavaSR
                  </button>
                )}
              </>
            )}

            {/* Enhance button — needs setup */}
            {enhanceStatus === 'needs-setup' && !isSettingUp && (
              <button
                onClick={handleSetup}
                disabled={disabled}
                className="text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
              >
                Set up LavaSR to enhance
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

          {/* Setup progress inline */}
          {isSettingUp && (
            <div className="flex items-center gap-2 text-xs text-accent">
              <svg className="w-3.5 h-3.5 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span>{setupMessage || 'Setting up LavaSR...'}</span>
            </div>
          )}

          {/* Setup error */}
          {setupError && (
            <div className="text-xs text-red-400">{setupError}</div>
          )}
        </div>
      )}
    </div>
  );
}
