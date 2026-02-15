import React from 'react';
import type { GenerationStatus } from '../App';

interface SynthesizeButtonProps {
  onClick: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  status: GenerationStatus;
  isPaused: boolean;
  disabled?: boolean;
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function SynthesizeButton({
  onClick,
  onStop,
  onPause,
  onResume,
  status,
  isPaused,
  disabled,
}: SynthesizeButtonProps) {
  const isActive = status === 'generating' || status === 'streaming';

  // During generation (before audio starts): show "Generating..." + Stop
  if (status === 'generating') {
    return (
      <div className="flex gap-3">
        <div className="flex-1 py-4 rounded-lg bg-gray-600 text-white font-semibold text-lg flex items-center justify-center gap-3">
          <SpinnerIcon />
          Generating...
        </div>
        <button
          onClick={onStop}
          className="px-6 py-4 rounded-lg bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-semibold text-lg transition-colors flex items-center gap-2"
          title="Stop generation"
        >
          <StopIcon />
          Stop
        </button>
      </div>
    );
  }

  // During streaming (audio playing): show Pause/Resume + Stop
  if (status === 'streaming') {
    return (
      <div className="flex gap-3">
        <button
          onClick={isPaused ? onResume : onPause}
          className="flex-1 py-4 rounded-lg bg-accent hover:bg-accent-hover active:bg-accent text-white font-semibold text-lg transition-colors flex items-center justify-center gap-3"
          title={isPaused ? 'Resume playback' : 'Pause playback'}
        >
          {isPaused ? <PlayIcon /> : <PauseIcon />}
          {isPaused ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={onStop}
          className="px-6 py-4 rounded-lg bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-semibold text-lg transition-colors flex items-center gap-2"
          title="Stop playback and cancel"
        >
          <StopIcon />
          Stop
        </button>
      </div>
    );
  }

  // Idle / complete / error / cancelled: show Synthesize button
  return (
    <button
      onClick={onClick}
      disabled={disabled || isActive}
      className={`w-full py-4 rounded-lg text-white font-semibold text-lg transition-colors
        ${disabled || isActive
          ? 'bg-gray-600 cursor-not-allowed'
          : 'bg-accent hover:bg-accent-hover active:bg-accent'
        }`}
    >
      Synthesize
    </button>
  );
}
