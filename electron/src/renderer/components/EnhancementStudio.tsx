import { useState, useCallback, useEffect } from 'react';
import { Modal } from './Modal';
import { AudioCompare } from './AudioCompare';
import type { SavedVoice } from './VoiceSelector';

type EnhanceStatus = 'idle' | 'enhancing' | 'preview' | 'saving' | 'error';

interface EnhancementStudioProps {
  isOpen: boolean;
  onClose: () => void;
  /** ID of saved voice to enhance (null = fresh upload via audioData) */
  voiceId: string | null;
  /** Voice name for display */
  voiceName: string | null;
  /** Raw audio data for enhancing unsaved uploads */
  audioData?: ArrayBuffer | null;
  /** Called after successful enhancement accept */
  onAccepted: (updatedVoice: SavedVoice) => void;
}

/**
 * Enhancement Studio modal — preview LavaSR enhancement before committing.
 * Provides A/B comparison, denoise toggle, and RMS normalization controls.
 */
export function EnhancementStudio({
  isOpen,
  onClose,
  voiceId,
  voiceName,
  audioData,
  onAccepted,
}: EnhancementStudioProps) {
  const [status, setStatus] = useState<EnhanceStatus>('idle');
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [denoise, setDenoise] = useState(true);
  const [rmsTargetDb, setRmsTargetDb] = useState(-16);
  const [originalAudio, setOriginalAudio] = useState<ArrayBuffer | null>(null);
  const [enhancedAudio, setEnhancedAudio] = useState<ArrayBuffer | null>(null);

  // Listen for progress events from main process
  useEffect(() => {
    if (!isOpen) return;

    const handleProgress = (progressStatus: string, details?: Record<string, unknown>) => {
      switch (progressStatus) {
        case 'loading':
          setProgressMessage(`Loading LavaSR model on ${details?.device ?? 'CPU'}...`);
          break;
        case 'enhancing':
          setProgressMessage(`Enhancing (denoise=${details?.denoise ?? true})...`);
          break;
        case 'done':
          setProgressMessage('Enhancement complete');
          break;
        default:
          setProgressMessage(progressStatus);
      }
    };

    window.electronAPI?.onEnhanceProgress(handleProgress);

    return () => {
      // Note: removeAllListeners would also remove TTS listeners.
      // In production you'd want a targeted remove — for now this is fine
      // since enhancement and TTS don't run simultaneously.
    };
  }, [isOpen]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setStatus('idle');
      setError(null);
      setOriginalAudio(null);
      setEnhancedAudio(null);
      setProgressMessage('');
    }
  }, [isOpen]);

  const handleEnhance = useCallback(async () => {
    setStatus('enhancing');
    setError(null);
    setProgressMessage('Starting enhancement...');

    try {
      const result = await window.electronAPI.enhancePreview({
        voiceId: voiceId ?? undefined,
        audioData: audioData ?? undefined,
        denoise,
      });

      setOriginalAudio(result.original);
      setEnhancedAudio(result.enhanced);
      setStatus('preview');
      setProgressMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enhancement failed');
      setStatus('error');
      setProgressMessage('');
    }
  }, [voiceId, audioData, denoise]);

  const handleAccept = useCallback(async () => {
    if (!voiceId) {
      // Can't accept without a saved voice ID — user needs to save first
      setError('Voice must be saved before accepting enhancement');
      return;
    }

    setStatus('saving');
    setError(null);

    try {
      const updatedVoice = await window.electronAPI.enhanceAccept(voiceId);

      // Also update normalization settings if changed from defaults
      if (rmsTargetDb !== -16 || !denoise) {
        await window.electronAPI.updateVoiceNormalization({
          voiceId,
          rmsTargetDb,
          denoise,
        });
      }

      onAccepted(updatedVoice);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save enhancement');
      setStatus('preview');
    }
  }, [voiceId, rmsTargetDb, denoise, onAccepted, onClose]);

  const handleReject = useCallback(async () => {
    try {
      await window.electronAPI.enhanceReject();
    } catch {
      // ignore cleanup errors
    }
    onClose();
  }, [onClose]);

  const handleReEnhance = useCallback(() => {
    setOriginalAudio(null);
    setEnhancedAudio(null);
    setStatus('idle');
    setError(null);
    setProgressMessage('');
  }, []);

  const handleClose = useCallback(() => {
    // Clean up if there's a pending enhancement
    if (status === 'preview') {
      window.electronAPI?.enhanceReject().catch(() => {});
    }
    onClose();
  }, [status, onClose]);

  const isProcessing = status === 'enhancing' || status === 'saving';

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Enhancement Studio" maxWidth="max-w-2xl">
      <div className="space-y-4" style={{ minWidth: '500px' }}>
        {/* Voice info */}
        <div className="bg-bg-tertiary rounded-lg px-3 py-2">
          <span className="text-xs text-text-secondary">Voice: </span>
          <span className="text-sm text-text-primary font-medium">
            {voiceName ?? 'Uploaded audio'}
          </span>
        </div>

        {/* Settings */}
        <div className="bg-bg-tertiary rounded-lg p-4 space-y-4">
          <h3 className="text-sm font-medium text-text-primary">Enhancement Settings</h3>

          {/* Denoise toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-text-secondary">Denoise</label>
            <button
              onClick={() => setDenoise(!denoise)}
              disabled={isProcessing}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                denoise ? 'bg-accent' : 'bg-border-color'
              } ${isProcessing ? 'opacity-50' : 'cursor-pointer'}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  denoise ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* RMS Target */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-sm text-text-secondary">RMS Target Level</label>
              <span className="text-xs text-text-secondary font-mono">{rmsTargetDb} dB</span>
            </div>
            <input
              type="range"
              min="-30"
              max="-6"
              step="1"
              value={rmsTargetDb}
              onChange={(e) => setRmsTargetDb(Number(e.target.value))}
              disabled={isProcessing}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-text-secondary">
              <span>Quieter (-30)</span>
              <span>Louder (-6)</span>
            </div>
          </div>
        </div>

        {/* Status / Progress */}
        {status === 'enhancing' && (
          <div className="flex items-center gap-3 bg-accent/10 text-accent rounded-lg px-4 py-3">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm">{progressMessage || 'Enhancing...'}</span>
          </div>
        )}

        {status === 'saving' && (
          <div className="flex items-center gap-3 bg-green-500/10 text-green-400 rounded-lg px-4 py-3">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm">Saving enhanced voice...</span>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* A/B Comparison (shown after enhancement) */}
        {status === 'preview' && (
          <AudioCompare originalAudio={originalAudio} enhancedAudio={enhancedAudio} />
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-2">
          {status === 'idle' || status === 'error' ? (
            <>
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 text-sm text-text-primary bg-bg-tertiary hover:bg-border-color rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleEnhance}
                className="flex-1 px-4 py-2 text-sm text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors"
              >
                Enhance
              </button>
            </>
          ) : status === 'preview' ? (
            <>
              <button
                onClick={handleReject}
                className="px-4 py-2 text-sm text-text-primary bg-bg-tertiary hover:bg-border-color rounded-lg transition-colors"
              >
                Reject
              </button>
              <button
                onClick={handleReEnhance}
                className="px-4 py-2 text-sm text-text-secondary bg-bg-tertiary hover:bg-border-color rounded-lg transition-colors"
              >
                Re-enhance
              </button>
              <button
                onClick={handleAccept}
                className="flex-1 px-4 py-2 text-sm text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
              >
                Accept & Save
              </button>
            </>
          ) : (
            // enhancing or saving — just show cancel
            <button
              onClick={handleClose}
              disabled={status === 'saving'}
              className="flex-1 px-4 py-2 text-sm text-text-primary bg-bg-tertiary hover:bg-border-color rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
