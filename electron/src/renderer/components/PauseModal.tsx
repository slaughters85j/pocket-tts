import React, { useState, useCallback } from 'react';
import { Modal } from './Modal';

interface PauseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInsert: (duration: number) => void;
}

const PRESETS = [0.5, 1, 2, 3, 5];

function formatDuration(val: number): string {
  return parseFloat(val.toFixed(1)).toString();
}

export function PauseModal({ isOpen, onClose, onInsert }: PauseModalProps) {
  const [duration, setDuration] = useState(1.0);

  const handleInsert = useCallback(() => {
    onInsert(duration);
    onClose();
  }, [duration, onInsert, onClose]);

  const handleClose = useCallback(() => {
    setDuration(1.0);
    onClose();
  }, [onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Insert Pause">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Insert a silence pause into your text at the current cursor position.
        </p>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">
            Duration: {formatDuration(duration)}s
          </label>
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={duration}
            onChange={(e) => setDuration(parseFloat(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs text-text-secondary mt-1">
            <span>0.1s</span>
            <span>10s</span>
          </div>
        </div>

        <div className="flex gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => setDuration(preset)}
              className={`px-3 py-1 text-xs rounded-lg border transition-colors
                ${duration === preset
                  ? 'bg-accent text-white border-accent'
                  : 'bg-bg-tertiary text-text-secondary border-border-color hover:border-accent'
                }`}
            >
              {preset}s
            </button>
          ))}
        </div>

        <div className="bg-bg-tertiary rounded-lg px-3 py-2 text-sm text-text-secondary font-mono">
          Preview: [{formatDuration(duration)}s]
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2 text-sm text-text-primary bg-bg-tertiary hover:bg-border-color rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleInsert}
            className="flex-1 px-4 py-2 text-sm text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors"
          >
            Insert Pause
          </button>
        </div>
      </div>
    </Modal>
  );
}
