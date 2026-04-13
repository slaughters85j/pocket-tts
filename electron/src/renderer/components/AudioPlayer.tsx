import React, { useRef, useState, useEffect, useCallback } from 'react';

type AudioFormat = 'wav' | 'mp3' | 'm4a';

interface AudioPlayerProps {
  audioBlob: Blob;
  scriptText?: string;
}

const FORMAT_OPTIONS: { format: AudioFormat; label: string; ext: string }[] = [
  { format: 'wav', label: 'WAV', ext: '.wav' },
  { format: 'mp3', label: 'MP3', ext: '.mp3' },
  { format: 'm4a', label: 'M4A', ext: '.m4a' },
];

export function AudioPlayer({ audioBlob, scriptText }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [showFormatMenu, setShowFormatMenu] = useState(false);
  const [encoding, setEncoding] = useState<AudioFormat | null>(null);
  const [m4aAvailable, setM4aAvailable] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check M4A support via IPC (doesn't depend on audio-encoder module)
  useEffect(() => {
    window.electronAPI?.isM4aAvailable()
      .then(setM4aAvailable)
      .catch(() => setM4aAvailable(false));
  }, []);

  useEffect(() => {
    console.log('[AudioPlayer] Received audio blob:', {
      size: audioBlob.size,
      type: audioBlob.type,
    });
    const url = URL.createObjectURL(audioBlob);
    console.log('[AudioPlayer] Created blob URL:', url);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audioBlob]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => {
      console.log('[AudioPlayer] loadedmetadata event - duration:', audio.duration);
      if (isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const handleDurationChange = () => {
      console.log('[AudioPlayer] durationchange event - duration:', audio.duration);
      if (isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const handleCanPlayThrough = () => {
      console.log('[AudioPlayer] canplaythrough event - duration:', audio.duration);
      if (isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const handleEnded = () => setIsPlaying(false);
    const handlePlay = () => {
      console.log('[AudioPlayer] play event fired');
      setIsPlaying(true);
    };
    const handlePause = () => setIsPlaying(false);
    const handleError = (e: Event) => {
      console.error('[AudioPlayer] Audio error:', (e.target as HTMLAudioElement).error);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('canplaythrough', handleCanPlayThrough);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    // Force load metadata
    console.log('[AudioPlayer] Calling audio.load()');
    audio.load();

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('canplaythrough', handleCanPlayThrough);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
    };
  }, [audioUrl]);

  const togglePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    console.log('[AudioPlayer] Play button clicked, audio element:', audio);
    console.log('[AudioPlayer] Current state:', { isPlaying, currentTime, duration, audioUrl });
    if (!audio) {
      console.error('[AudioPlayer] No audio element ref!');
      return;
    }

    if (isPlaying) {
      console.log('[AudioPlayer] Pausing...');
      audio.pause();
    } else {
      console.log('[AudioPlayer] Playing... readyState:', audio.readyState, 'src:', audio.src);
      try {
        await audio.play();
        console.log('[AudioPlayer] Play started successfully');
      } catch (error) {
        console.error('[AudioPlayer] Failed to play audio:', error);
      }
    }
  }, [isPlaying, currentTime, duration, audioUrl]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;

    const time = parseFloat(e.target.value);
    audio.currentTime = time;
    setCurrentTime(time);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showFormatMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowFormatMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFormatMenu]);

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleDownload = useCallback(async (format: AudioFormat) => {
    setShowFormatMenu(false);
    setEncoding(format);

    try {
      // Lazy-load the encoder module (lamejs is heavy and may fail at import time in some envs)
      const encoder = await import('../lib/audio-encoder');

      let outputBlob: Blob;
      switch (format) {
        case 'wav':
          outputBlob = await encoder.toStereoWav(audioBlob);
          break;
        case 'mp3':
          outputBlob = await encoder.encodeToMp3(audioBlob);
          break;
        case 'm4a':
          outputBlob = await encoder.encodeToM4a(audioBlob);
          break;
      }

      // Route through main process: native save dialog writes audio + companion .txt
      if (window.electronAPI?.exportAudio) {
        const audioBuffer = await outputBlob.arrayBuffer();
        await window.electronAPI.exportAudio({ audioBuffer, scriptText, format });
      } else {
        // Fallback for non-Electron (e.g. plain browser dev)
        downloadBlob(outputBlob, `pocket-tts-output.${format}`);
      }
    } catch (error) {
      console.error(`[AudioPlayer] Failed to encode ${format}:`, error);
    } finally {
      setEncoding(null);
    }
  }, [audioBlob, scriptText, downloadBlob]);

  const formatTime = (time: number) => {
    if (!isFinite(time)) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!audioUrl) return null;

  return (
    <div className="bg-bg-secondary rounded-lg p-4">
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      <div className="flex items-center gap-4">
        {/* Play/Pause Button */}
        <button
          onClick={togglePlayPause}
          className="w-12 h-12 flex items-center justify-center rounded-full bg-accent hover:bg-accent-hover transition-colors"
        >
          {isPlaying ? (
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Progress Bar */}
        <div className="flex-1">
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={currentTime}
            onChange={handleSeek}
            className="w-full h-2 bg-bg-tertiary rounded-lg appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:w-3
              [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:bg-accent"
          />
          <div className="flex justify-between text-xs text-text-secondary mt-1">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Download Button with Format Menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowFormatMenu((prev) => !prev)}
            disabled={encoding !== null}
            className="w-10 h-10 flex items-center justify-center rounded-lg bg-bg-tertiary hover:bg-border-color transition-colors disabled:opacity-50"
            title="Download audio"
          >
            {encoding ? (
              <svg className="w-5 h-5 text-text-primary animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            )}
          </button>

          {showFormatMenu && (
            <div className="absolute right-0 bottom-full mb-2 bg-bg-tertiary rounded-lg shadow-lg border border-border-color overflow-hidden z-10 min-w-[120px]">
              {FORMAT_OPTIONS.map(({ format, label }) => {
                const disabled = format === 'm4a' && !m4aAvailable;
                return (
                  <button
                    key={format}
                    onClick={() => !disabled && handleDownload(format)}
                    disabled={disabled}
                    className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-border-color transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-between"
                  >
                    <span>{label}</span>
                    <span className="text-xs text-text-secondary ml-3">
                      {format === 'wav' ? 'Lossless' : format === 'mp3' ? '192 kbps' : 'AAC'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Encoding status */}
      {encoding && (
        <div className="mt-2 text-xs text-text-secondary text-center">
          Encoding {encoding.toUpperCase()}...
        </div>
      )}
    </div>
  );
}
