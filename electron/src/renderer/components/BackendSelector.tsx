import React, { useState, useEffect, useCallback } from 'react';

export interface BackendInfo {
  available: string[];
  active: string | null;
  supports_tags: boolean;
}

export interface FishGenParams {
  temperature: number;
  topP: number;
  topK: number;
}

const BACKEND_LABELS: Record<string, string> = {
  'pocket-tts': 'Pocket TTS (100M, CPU)',
  'fish-speech': 'Fish Audio S2 Pro (5B, MLX)',
};

const DEFAULT_FISH_PARAMS: FishGenParams = {
  temperature: 0.7,
  topP: 0.7,
  topK: 30,
};

interface BackendSelectorProps {
  disabled?: boolean;
  onBackendChange?: (info: BackendInfo) => void;
  fishParams?: FishGenParams;
  onFishParamsChange?: (params: FishGenParams) => void;
}

export function BackendSelector({ disabled, onBackendChange, fishParams: controlledFishParams, onFishParamsChange }: BackendSelectorProps) {
  const [backendInfo, setBackendInfo] = useState<BackendInfo>({
    available: ['pocket-tts'],
    active: null,
    supports_tags: false,
  });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use controlled params from parent (syncs with history reuse)
  const fishParams = controlledFishParams ?? DEFAULT_FISH_PARAMS;

  // Fetch backend info on mount and after switches
  const fetchBackends = useCallback(async () => {
    try {
      const info = await window.electronAPI?.getBackends();
      if (info) {
        setBackendInfo(info);
        onBackendChange?.(info);
      }
    } catch {
      // Server might not be up yet — retry quietly
    }
  }, [onBackendChange]);

  useEffect(() => {
    fetchBackends();
    // Poll until we get an active backend (server startup)
    const interval = setInterval(() => {
      if (!backendInfo.active) fetchBackends();
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchBackends, backendInfo.active]);

  const handleSwitch = useCallback(
    async (name: string) => {
      if (name === backendInfo.active || switching) return;
      setSwitching(true);
      setError(null);
      try {
        await window.electronAPI?.switchBackend(name);
        await fetchBackends();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Switch failed');
      } finally {
        setSwitching(false);
      }
    },
    [backendInfo.active, switching, fetchBackends]
  );

  const updateParam = useCallback(
    (key: keyof FishGenParams, value: number) => {
      const updated = { ...fishParams, [key]: value };
      onFishParamsChange?.(updated);
    },
    [fishParams, onFishParamsChange]
  );

  // Only show selector if more than one backend is available
  if (backendInfo.available.length <= 1) return null;

  return (
    <div className="bg-bg-secondary rounded-lg p-4">
      <label className="block text-sm font-medium text-text-primary mb-3">Model</label>
      <select
        value={backendInfo.active || ''}
        onChange={(e) => handleSwitch(e.target.value)}
        disabled={disabled || switching}
        className={`w-full bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-4 py-3 text-sm
          focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
          ${disabled || switching ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        {backendInfo.available.map((name) => (
          <option key={name} value={name}>
            {BACKEND_LABELS[name] || name}
          </option>
        ))}
      </select>
      {switching && (
        <p className="mt-2 text-xs text-accent animate-pulse">Switching model — loading weights...</p>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      {/* Fish-speech generation controls */}
      {backendInfo.active === 'fish-speech' && !switching && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-text-secondary">
            Supports inline [tags] for emotion/prosody — e.g.{' '}
            <code className="text-accent">[whisper]</code>, <code className="text-accent">[excited]</code>
          </p>

          {/* Temperature */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs text-text-secondary">Temperature</label>
              <span className="text-xs text-text-primary font-mono">{fishParams.temperature.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="1.5"
              step="0.05"
              value={fishParams.temperature}
              onChange={(e) => updateParam('temperature', parseFloat(e.target.value))}
              disabled={disabled}
              className="w-full accent-accent"
            />
            <p className="text-[10px] text-text-secondary mt-0.5">
              Lower = consistent, predictable. Higher = expressive, varied. Default 0.7.
            </p>
          </div>

          {/* Top P */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs text-text-secondary">Top P</label>
              <span className="text-xs text-text-primary font-mono">{fishParams.topP.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              value={fishParams.topP}
              onChange={(e) => updateParam('topP', parseFloat(e.target.value))}
              disabled={disabled}
              className="w-full accent-accent"
            />
            <p className="text-[10px] text-text-secondary mt-0.5">
              Nucleus sampling threshold. Lower = more focused. Higher = broader vocab. Default 0.7.
            </p>
          </div>

          {/* Top K */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs text-text-secondary">Top K</label>
              <span className="text-xs text-text-primary font-mono">{fishParams.topK}</span>
            </div>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={fishParams.topK}
              onChange={(e) => updateParam('topK', parseInt(e.target.value))}
              disabled={disabled}
              className="w-full accent-accent"
            />
            <p className="text-[10px] text-text-secondary mt-0.5">
              Token candidates per step. Lower = deterministic. Higher = creative. Default 30.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
