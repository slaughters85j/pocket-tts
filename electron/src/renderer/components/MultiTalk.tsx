import React, { useState, useCallback, useRef, useEffect } from 'react';
import { SpeakerCard, Speaker } from './SpeakerCard';
import { AudioPlayer } from './AudioPlayer';
import { SynthesizeButton } from './SynthesizeButton';
import { StatusIndicator } from './StatusIndicator';
import { StreamingWavPlayer } from '../lib/streaming-wav-player';
import { GenerationStatus } from '../App';
import { PREDEFINED_VOICES, SavedVoice } from './VoiceSelector';
import { addToHistory } from './History';
import { PauseModal } from './PauseModal';
import { BackendSelector, BackendInfo, FishGenParams } from './BackendSelector';

interface MultiTalkExportConfig {
  version: string;
  speakers: {
    name: string;
    voice_source: string;
    voice_data: string | null;
    seed: number | null;
  }[];
  script: string;
  settings: {
    crossfade_ms: number;
  };
}

interface GenerationState {
  status: GenerationStatus;
  timeToFirstAudio: number | null;
  totalTime: number | null;
  error: string | null;
}

export interface MultiTalkConfig {
  script: string;
  speakers: {
    name: string;
    voice: string;
    voiceName?: string;
    customUrl?: string | null;
    fileData?: string | null;
    seed?: number | null;
  }[];
}

interface MultiTalkProps {
  pendingConfig?: MultiTalkConfig | null;
  onConfigLoaded?: () => void;
  onBackendChange?: (info: BackendInfo) => void;
  backendName?: string | null;
  fishParams?: FishGenParams;
  onFishParamsChange?: (params: FishGenParams) => void;
}

let nextSpeakerId = 1;

export function MultiTalk({ pendingConfig, onConfigLoaded, onBackendChange, backendName, fishParams, onFishParamsChange }: MultiTalkProps) {
  const [speakers, setSpeakers] = useState<Speaker[]>([
    {
      id: `speaker-${nextSpeakerId++}`,
      name: 'Alice',
      voice: 'alba',
      seed: null,
      customUrl: null,
      fileData: null,
      fileName: null,
    },
  ]);
  const [script, setScript] = useState('');
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [savedVoices, setSavedVoices] = useState<SavedVoice[]>([]);
  const [normStrategy, setNormStrategy] = useState<'per_voice' | 'match_quietest' | 'match_loudest'>('per_voice');

  // Load saved voices on mount
  useEffect(() => {
    window.electronAPI?.getSavedVoices().then(setSavedVoices);
  }, []);
  const [generationState, setGenerationState] = useState<GenerationState>({
    status: 'idle',
    timeToFirstAudio: null,
    totalTime: null,
    error: null,
  });
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  // Load config from history when pendingConfig changes
  useEffect(() => {
    if (pendingConfig) {
      const newSpeakers: Speaker[] = pendingConfig.speakers.map((s) => ({
        id: `speaker-${nextSpeakerId++}`,
        name: s.name,
        voice: s.voice,
        seed: s.seed ?? null,
        customUrl: s.customUrl ?? null,
        fileData: s.fileData ?? null,
        fileName: s.fileData ? 'Loaded from history' : null,
      }));
      setSpeakers(newSpeakers);
      setScript(pendingConfig.script);
      onConfigLoaded?.();
    }
  }, [pendingConfig, onConfigLoaded]);

  const playerRef = useRef<StreamingWavPlayer | null>(null);
  const startTimeRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);

  const addSpeaker = useCallback(() => {
    const newSpeaker: Speaker = {
      id: `speaker-${nextSpeakerId++}`,
      name: `Speaker ${speakers.length + 1}`,
      voice: 'alba',
      seed: null,
      customUrl: null,
      fileData: null,
      fileName: null,
    };
    setSpeakers((prev) => [...prev, newSpeaker]);
  }, [speakers.length]);

  const removeSpeaker = useCallback((id: string) => {
    setSpeakers((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const updateSpeaker = useCallback((id: string, updates: Partial<Speaker>) => {
    setSpeakers((prev) => {
      const oldSpeaker = prev.find((s) => s.id === id);
      const newSpeakers = prev.map((s) => (s.id === id ? { ...s, ...updates } : s));

      // If name changed, update script tags
      if (oldSpeaker && updates.name && updates.name !== oldSpeaker.name) {
        const oldName = oldSpeaker.name;
        const newName = updates.name;
        // Replace {OldName} with {NewName} in script (case-insensitive match)
        const pattern = new RegExp(`\\{${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'gi');
        setScript((prevScript) => prevScript.replace(pattern, `{${newName}}`));
      }

      return newSpeakers;
    });
  }, []);

  const insertSpeakerToScript = useCallback((name: string) => {
    const textarea = scriptTextareaRef.current;
    const tag = `{${name}} `;

    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      // Determine if we need a newline prefix
      let prefix = '';
      if (start > 0) {
        const charBefore = script.charAt(start - 1);
        if (charBefore !== '\n') {
          prefix = '\n';
        }
      }

      const insertion = prefix + tag;
      const newScript = script.slice(0, start) + insertion + script.slice(end);
      setScript(newScript);

      // Set cursor position after the inserted tag
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + insertion.length, start + insertion.length);
      }, 0);
    } else {
      // Fallback: append to end with newline
      setScript((prev) => (prev && !prev.endsWith('\n') ? prev + '\n' : prev) + tag);
    }
  }, [script]);

  const handleInsertPause = useCallback((duration: number) => {
    const textarea = scriptTextareaRef.current;
    const formatted = parseFloat(duration.toFixed(1)).toString();
    const marker = `[${formatted}s]`;

    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newScript = script.slice(0, start) + marker + script.slice(end);
      setScript(newScript);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + marker.length, start + marker.length);
      }, 0);
    } else {
      setScript((prev) => prev + marker);
    }
  }, [script]);

  const handleGenerate = useCallback(async () => {
    if (!script.trim()) {
      setGenerationState({
        status: 'error',
        timeToFirstAudio: null,
        totalTime: null,
        error: 'Please enter a script.',
      });
      return;
    }

    if (speakers.length === 0) {
      setGenerationState({
        status: 'error',
        timeToFirstAudio: null,
        totalTime: null,
        error: 'Please add at least one speaker.',
      });
      return;
    }

    // Validate speakers
    for (const speaker of speakers) {
      if (speaker.voice === 'custom_url' && !speaker.customUrl) {
        setGenerationState({
          status: 'error',
          timeToFirstAudio: null,
          totalTime: null,
          error: `Speaker "${speaker.name}" needs a custom URL.`,
        });
        return;
      }
      if (speaker.voice === 'upload' && !speaker.fileData) {
        setGenerationState({
          status: 'error',
          timeToFirstAudio: null,
          totalTime: null,
          error: `Speaker "${speaker.name}" needs an uploaded WAV file.`,
        });
        return;
      }
    }

    // Reset state
    setGenerationState({
      status: 'generating',
      timeToFirstAudio: null,
      totalTime: null,
      error: null,
    });
    setAudioBlob(null);
    setIsPaused(false);
    playerRef.current?.stop();

    startTimeRef.current = performance.now();

    // Set up streaming player
    playerRef.current = new StreamingWavPlayer({
      onFirstAudio: () => {
        const timeToFirst = (performance.now() - startTimeRef.current) / 1000;
        setGenerationState((prev) => ({
          ...prev,
          status: 'streaming',
          timeToFirstAudio: timeToFirst,
        }));
      },
      onComplete: () => {
        const totalTime = (performance.now() - startTimeRef.current) / 1000;
        setGenerationState((prev) => ({
          ...prev,
          status: 'complete',
          totalTime,
        }));
        if (playerRef.current) {
          setAudioBlob(playerRef.current.getAudioBlob());
        }

        // Save to history
        addToHistory({
          type: 'multi',
          script,
          speakers: speakers.map((s) => {
            // Get voice display name
            let voiceName = s.name;
            if (s.voice.startsWith('saved:')) {
              const saved = savedVoices.find((v) => `saved:${v.id}` === s.voice);
              if (saved) voiceName = saved.name;
            } else {
              const predefined = PREDEFINED_VOICES.find((v) => v.id === s.voice);
              if (predefined) voiceName = predefined.name;
            }
            return {
              name: s.name,
              voice: s.voice,
              voiceName,
              customUrl: s.customUrl,
              fileData: s.fileData,
              seed: s.seed,
            };
          }),
          backend: backendName || undefined,
          fishTemperature: backendName === 'fish-speech' ? fishParams?.temperature : undefined,
          fishTopP: backendName === 'fish-speech' ? fishParams?.topP : undefined,
          fishTopK: backendName === 'fish-speech' ? fishParams?.topK : undefined,
        });
      },
      onError: (error) => {
        setGenerationState((prev) => ({
          ...prev,
          status: 'error',
          error: error.message,
        }));
      },
    });

    // Set up IPC listeners
    window.electronAPI.removeAllListeners();

    window.electronAPI.onTTSChunk((chunk) => {
      playerRef.current?.addChunk(new Uint8Array(chunk));
    });

    window.electronAPI.onTTSComplete(() => {
      playerRef.current?.flushRemaining();
    });

    window.electronAPI.onTTSError((error) => {
      setGenerationState((prev) => ({
        ...prev,
        status: 'error',
        error,
      }));
    });

    window.electronAPI.onTTSCancelled(() => {
      setGenerationState((prev) => ({
        ...prev,
        status: 'cancelled',
      }));
      if (playerRef.current) {
        setAudioBlob(playerRef.current.getAudioBlob());
      }
    });

    // Build speakers data with per-voice normalization
    const perVoiceDbValues = speakers.map((s) => {
      if (s.voice.startsWith('saved:')) {
        const savedId = s.voice.replace('saved:', '');
        const saved = savedVoices.find((v) => v.id === savedId);
        return saved?.audioNormalization?.rmsTargetDb ?? -16;
      }
      return -16; // default for predefined/uploaded/URL voices
    });

    // Resolve effective target_db per speaker based on strategy
    let effectiveDbValues: number[];
    if (normStrategy === 'match_quietest') {
      const quietest = Math.min(...perVoiceDbValues);
      effectiveDbValues = perVoiceDbValues.map(() => quietest);
    } else if (normStrategy === 'match_loudest') {
      const loudest = Math.max(...perVoiceDbValues);
      effectiveDbValues = perVoiceDbValues.map(() => loudest);
    } else {
      effectiveDbValues = perVoiceDbValues; // per_voice
    }

    const speakersData = speakers.map((s, i) => ({
      name: s.name,
      voice_source:
        s.voice === 'upload'
          ? 'uploaded'
          : s.voice === 'custom_url'
          ? s.customUrl!
          : s.voice, // includes 'saved:id' and predefined voices
      voice_data: s.voice === 'upload' ? s.fileData : null,
      seed: s.seed,
      rms_target_db: effectiveDbValues[i],
    }));

    try {
      await window.electronAPI.generateMultiTTS({
        script,
        speakers: speakersData,
        crossfade_ms: 100,
        fishTemperature: fishParams?.temperature,
        fishTopP: fishParams?.topP,
        fishTopK: fishParams?.topK,
      });
    } catch (error) {
      setGenerationState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }, [script, speakers, normStrategy, savedVoices]);

  const handleStop = useCallback(() => {
    playerRef.current?.stop();
    window.electronAPI?.cancelTTS();
    setIsPaused(false);
    if (playerRef.current) {
      setAudioBlob(playerRef.current.getAudioBlob());
    }
    setGenerationState((prev) => ({
      ...prev,
      status: 'cancelled',
    }));
  }, []);

  const handlePause = useCallback(() => {
    playerRef.current?.pause();
    setIsPaused(true);
  }, []);

  const handleResume = useCallback(() => {
    playerRef.current?.resume();
    setIsPaused(false);
  }, []);

  const handleExport = useCallback(() => {
    const config: MultiTalkExportConfig = {
      version: '1.0',
      speakers: speakers.map((s) => ({
        name: s.name,
        voice_source:
          s.voice === 'upload'
            ? 'uploaded'
            : s.voice === 'custom_url'
            ? s.customUrl!
            : s.voice,
        voice_data: s.voice === 'upload' ? s.fileData : null,
        seed: s.seed,
      })),
      script,
      settings: {
        crossfade_ms: 100,
      },
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'multi-talk-config.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [speakers, script]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const config = JSON.parse(
            event.target?.result as string
          ) as MultiTalkExportConfig;

          // Convert config speakers to UI speakers
          const newSpeakers: Speaker[] = config.speakers.map((s) => {
            let voice = s.voice_source;
            let customUrl: string | null = null;

            if (s.voice_source === 'uploaded') {
              voice = 'upload';
            } else if (s.voice_source?.startsWith('saved:')) {
              // Keep saved voice reference as-is
              voice = s.voice_source;
            } else if (
              s.voice_source?.startsWith('hf://') ||
              s.voice_source?.startsWith('http://') ||
              s.voice_source?.startsWith('https://')
            ) {
              customUrl = s.voice_source;
              voice = 'custom_url';
            } else if (
              !PREDEFINED_VOICES.find((v) => v.id === s.voice_source)
            ) {
              voice = 'alba'; // Fallback
            }

            return {
              id: `speaker-${nextSpeakerId++}`,
              name: s.name,
              voice,
              customUrl,
              fileData: s.voice_data,
              fileName: s.voice_data ? 'Imported audio' : null,
              seed: s.seed,
            };
          });

          setSpeakers(newSpeakers);
          setScript(config.script || '');
        } catch (error) {
          setGenerationState({
            status: 'error',
            timeToFirstAudio: null,
            totalTime: null,
            error: `Failed to import config: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      };
      reader.readAsText(file);

      // Reset input
      e.target.value = '';
    },
    []
  );

  const isGenerating =
    generationState.status === 'generating' ||
    generationState.status === 'streaming';

  return (
    <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 180px)' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImport}
        className="hidden"
      />

      {/* Two-Column Layout */}
      <div className="flex gap-6 flex-1 min-h-0">

        {/* Left Column: Speakers + Settings + Synthesize */}
        <div className="w-[380px] flex-shrink-0 flex flex-col space-y-4">
          {/* Speakers Section */}
          <div className="bg-bg-secondary rounded-lg p-4">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-sm font-medium text-text-primary">Speakers</h2>
              <button
                onClick={addSpeaker}
                disabled={isGenerating}
                className={`px-3 py-1.5 text-sm bg-accent text-white rounded-lg
                  hover:bg-accent-hover transition-colors
                  ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                + Add Speaker
              </button>
            </div>

            <div className="space-y-3">
              {speakers.map((speaker) => (
                <SpeakerCard
                  key={speaker.id}
                  speaker={speaker}
                  onUpdate={(updates) => updateSpeaker(speaker.id, updates)}
                  onRemove={() => removeSpeaker(speaker.id)}
                  onInsertToScript={insertSpeakerToScript}
                  canRemove={speakers.length > 1}
                  disabled={isGenerating}
                  savedVoices={savedVoices}
                />
              ))}
            </div>
          </div>

          {/* Model Selector */}
          <BackendSelector
            disabled={isGenerating}
            onBackendChange={onBackendChange}
            fishParams={fishParams}
            onFishParamsChange={onFishParamsChange}
          />

          {/* Volume Normalization Strategy */}
          <div className="bg-bg-secondary rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-text-primary">
                  Volume Normalization
                </label>
                <p className="text-xs text-text-secondary mt-0.5">
                  How to handle different loudness levels across speakers
                </p>
              </div>
              <select
                value={normStrategy}
                onChange={(e) => setNormStrategy(e.target.value as typeof normStrategy)}
                disabled={isGenerating}
                className={`bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-3 py-1.5 text-sm
                  focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
                  ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <option value="per_voice">Per Voice</option>
                <option value="match_quietest">Match Quietest</option>
                <option value="match_loudest">Match Loudest</option>
              </select>
            </div>
          </div>

          {/* Generate / Playback Controls */}
          <SynthesizeButton
            onClick={handleGenerate}
            onStop={handleStop}
            onPause={handlePause}
            onResume={handleResume}
            status={generationState.status}
            isPaused={isPaused}
            disabled={!script.trim()}
          />

          {/* Status Indicator */}
          <StatusIndicator
            status={generationState.status}
            timeToFirstAudio={generationState.timeToFirstAudio}
            totalTime={generationState.totalTime}
            error={generationState.error}
            isPaused={isPaused}
          />

          {/* Audio Player */}
          {audioBlob && (
            <div>
              <AudioPlayer audioBlob={audioBlob} />
            </div>
          )}
        </div>

        {/* Right Column: Script (fills remaining width and height) */}
        <div className="flex-1 flex flex-col min-w-0 pb-6">
          <div className="bg-bg-secondary rounded-lg p-4 flex flex-col flex-1">
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-text-primary">
                Script
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isGenerating}
                  className={`px-2.5 py-1 text-xs border border-border-color rounded-lg text-text-secondary
                    hover:bg-bg-tertiary hover:text-text-primary transition-colors
                    ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Import JSON
                </button>
                <button
                  onClick={handleExport}
                  disabled={isGenerating || speakers.length === 0}
                  className={`px-2.5 py-1 text-xs border border-border-color rounded-lg text-text-secondary
                    hover:bg-bg-tertiary hover:text-text-primary transition-colors
                    ${isGenerating || speakers.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Export JSON
                </button>
                <button
                  onClick={() => setShowPauseModal(true)}
                  disabled={isGenerating}
                  className={`px-2.5 py-1 text-xs border border-border-color rounded-lg text-text-secondary
                    hover:bg-bg-tertiary hover:text-text-primary transition-colors
                    ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title="Insert a pause marker"
                >
                  + Pause
                </button>
              </div>
            </div>
            <textarea
              ref={scriptTextareaRef}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              disabled={isGenerating}
              placeholder={`{Alice} Hello Bob, how are you today?\n{Bob} I'm doing great, thanks for asking!\n{Alice} That's wonderful to hear.`}
              className={`w-full flex-1 bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-4 py-3 text-sm font-mono
                placeholder:text-text-secondary/50
                focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
                resize-none min-h-[900px]
                ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
            <p className="mt-2 text-xs text-text-secondary">
              Use {'{SpeakerName}'} to indicate who speaks. Names must match
              speakers defined above.
            </p>
          </div>
        </div>

      </div>

      {/* Pause Insert Modal */}
      <PauseModal
        isOpen={showPauseModal}
        onClose={() => setShowPauseModal(false)}
        onInsert={handleInsertPause}
      />
    </div>
  );
}
