import React, { useRef, forwardRef, useImperativeHandle } from 'react';

export interface TextInputHandle {
  getSelectionStart: () => number;
  getSelectionEnd: () => number;
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
}

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onPauseClick?: () => void;
}

export const TextInput = forwardRef<TextInputHandle, TextInputProps>(
  function TextInput({ value, onChange, disabled, onPauseClick }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const charCount = value.length;
    const wordCount = value.trim().split(/\s+/).filter(Boolean).length;

    useImperativeHandle(ref, () => ({
      getSelectionStart: () => textareaRef.current?.selectionStart ?? value.length,
      getSelectionEnd: () => textareaRef.current?.selectionEnd ?? value.length,
      focus: () => textareaRef.current?.focus(),
      setSelectionRange: (start: number, end: number) =>
        textareaRef.current?.setSelectionRange(start, end),
    }));

    return (
      <div className="bg-bg-secondary rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <label className="block text-sm font-medium text-text-primary">
            Text to Generate
          </label>
          {onPauseClick && (
            <button
              onClick={onPauseClick}
              disabled={disabled}
              className={`px-2.5 py-1 text-xs border border-border-color rounded-lg text-text-secondary
                hover:bg-bg-tertiary hover:text-text-primary transition-colors
                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              title="Insert a pause marker"
            >
              + Pause
            </button>
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="Enter the text you want to convert to speech..."
          rows={5}
          className={`w-full bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-4 py-3 text-sm
            placeholder-text-secondary resize-y min-h-[300px]
            focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        />
        <div className="mt-2 flex justify-between text-xs text-text-secondary">
          <span>{wordCount} words</span>
          <span>{charCount} characters</span>
        </div>
      </div>
    );
  }
);
