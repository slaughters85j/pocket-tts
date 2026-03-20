import { useState, useRef, useEffect, useCallback } from 'react';

interface AudioCompareProps {
  originalAudio: ArrayBuffer | null;
  enhancedAudio: ArrayBuffer | null;
}

/**
 * A/B audio comparison widget.
 * Playing one track auto-stops the other for easy comparison.
 */
export function AudioCompare({ originalAudio, enhancedAudio }: AudioCompareProps) {
  const originalRef = useRef<HTMLAudioElement>(null);
  const enhancedRef = useRef<HTMLAudioElement>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [enhancedUrl, setEnhancedUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState<'none' | 'original' | 'enhanced'>('none');
  const [originalDuration, setOriginalDuration] = useState<number | null>(null);
  const [enhancedDuration, setEnhancedDuration] = useState<number | null>(null);

  // Create blob URLs when audio data changes
  useEffect(() => {
    if (originalAudio) {
      const blob = new Blob([originalAudio], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setOriginalUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setOriginalUrl(null);
    }
  }, [originalAudio]);

  useEffect(() => {
    if (enhancedAudio) {
      const blob = new Blob([enhancedAudio], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setEnhancedUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setEnhancedUrl(null);
    }
  }, [enhancedAudio]);

  const stopAll = useCallback(() => {
    if (originalRef.current) {
      originalRef.current.pause();
      originalRef.current.currentTime = 0;
    }
    if (enhancedRef.current) {
      enhancedRef.current.pause();
      enhancedRef.current.currentTime = 0;
    }
    setPlaying('none');
  }, []);

  const playOriginal = useCallback(() => {
    if (playing === 'original') {
      stopAll();
      return;
    }
    stopAll();
    originalRef.current?.play();
    setPlaying('original');
  }, [playing, stopAll]);

  const playEnhanced = useCallback(() => {
    if (playing === 'enhanced') {
      stopAll();
      return;
    }
    stopAll();
    enhancedRef.current?.play();
    setPlaying('enhanced');
  }, [playing, stopAll]);

  const formatDuration = (seconds: number | null): string => {
    if (seconds === null) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!originalUrl && !enhancedUrl) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Original */}
        <div
          className={`bg-bg-tertiary rounded-lg p-3 border-2 transition-colors ${
            playing === 'original' ? 'border-amber-500/60' : 'border-transparent'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Original
            </span>
            <span className="text-xs text-text-secondary">
              {formatDuration(originalDuration)}
            </span>
          </div>
          <button
            onClick={playOriginal}
            disabled={!originalUrl}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors
              ${playing === 'original'
                ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                : 'bg-bg-secondary text-text-primary hover:bg-border-color'
              }
              ${!originalUrl ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {playing === 'original' ? (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
                Stop
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <polygon points="5,3 19,12 5,21" />
                </svg>
                Play A
              </>
            )}
          </button>
          {originalUrl && (
            <audio
              ref={originalRef}
              src={originalUrl}
              onLoadedMetadata={() => setOriginalDuration(originalRef.current?.duration ?? null)}
              onEnded={() => setPlaying('none')}
            />
          )}
        </div>

        {/* Enhanced */}
        <div
          className={`bg-bg-tertiary rounded-lg p-3 border-2 transition-colors ${
            playing === 'enhanced' ? 'border-green-500/60' : 'border-transparent'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-green-400 uppercase tracking-wide">
              Enhanced
            </span>
            <span className="text-xs text-text-secondary">
              {formatDuration(enhancedDuration)}
            </span>
          </div>
          <button
            onClick={playEnhanced}
            disabled={!enhancedUrl}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors
              ${playing === 'enhanced'
                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                : 'bg-bg-secondary text-text-primary hover:bg-border-color'
              }
              ${!enhancedUrl ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {playing === 'enhanced' ? (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
                Stop
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <polygon points="5,3 19,12 5,21" />
                </svg>
                Play B
              </>
            )}
          </button>
          {enhancedUrl && (
            <audio
              ref={enhancedRef}
              src={enhancedUrl}
              onLoadedMetadata={() => setEnhancedDuration(enhancedRef.current?.duration ?? null)}
              onEnded={() => setPlaying('none')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
