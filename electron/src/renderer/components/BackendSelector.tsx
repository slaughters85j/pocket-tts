import React, { useState, useEffect, useCallback } from 'react';

export interface BackendInfo {
  available: string[];
  active: string | null;
  supports_tags: boolean;
}

const BACKEND_LABELS: Record<string, string> = {
  'pocket-tts': 'Pocket TTS (100M, CPU)',
  'fish-speech': 'Fish Audio S2 Pro (5B, MLX)',
};

interface BackendSelectorProps {
  disabled?: boolean;
  onBackendChange?: (info: BackendInfo) => void;
}

export function BackendSelector({ disabled, onBackendChange }: BackendSelectorProps) {
  const [backendInfo, setBackendInfo] = useState<BackendInfo>({
    available: ['pocket-tts'],
    active: null,
    supports_tags: false,
  });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      {backendInfo.active === 'fish-speech' && !switching && (
        <p className="mt-2 text-xs text-text-secondary">
          Fish Audio S2 Pro supports inline [tags] for emotion/prosody control. e.g.{' '}
          <code className="text-accent">[whisper]</code>, <code className="text-accent">[excited]</code>
        </p>
      )}
    </div>
  );
}
