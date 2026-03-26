import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ReferenceAudio } from './components/ReferenceAudio';
import { VoiceSelector, SavedVoice, PREDEFINED_VOICES } from './components/VoiceSelector';
import { PauseModal } from './components/PauseModal';
import { SynthesizeButton } from './components/SynthesizeButton';
import { AudioPlayer } from './components/AudioPlayer';
import { StatusIndicator } from './components/StatusIndicator';
import { SaveVoiceModal } from './components/SaveVoiceModal';
import { EnhancementStudio } from './components/EnhancementStudio';
import { MultiTalk, MultiTalkConfig } from './components/MultiTalk';
import { History, HistoryEntry, addToHistory } from './components/History';
import { BackendSelector, BackendInfo, FishGenParams } from './components/BackendSelector';
import { StreamingWavPlayer } from './lib/streaming-wav-player';
import './types/electron.d.ts';

export type GenerationStatus = 'idle' | 'generating' | 'streaming' | 'complete' | 'error' | 'cancelled';

type TabType = 'single' | 'multi' | 'history';

interface GenerationState {
  status: GenerationStatus;
  timeToFirstAudio: number | null;
  totalTime: number | null;
  error: string | null;
  statusMessage?: string | null;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('single');
  const [text, setText] = useState(
    "Hello world. I am Kyutai's Pocket TTS. I'm fast enough to run on small CPUs. I hope you'll like me."
  );
  const [selectedVoice, setSelectedVoice] = useState('alba');
  const [customAudioFile, setCustomAudioFile] = useState<File | null>(null);
  const [generationState, setGenerationState] = useState<GenerationState>({
    status: 'idle',
    timeToFirstAudio: null,
    totalTime: null,
    error: null,
  });
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [savedVoices, setSavedVoices] = useState<SavedVoice[]>([]);
  const [showSaveVoiceModal, setShowSaveVoiceModal] = useState(false);
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [showEnhancementStudio, setShowEnhancementStudio] = useState(false);
  const [enhancementTargetVoiceId, setEnhancementTargetVoiceId] = useState<string | null>(null);
  const [enhanceStatus, setEnhanceStatus] = useState<'ready' | 'needs-setup' | 'unavailable'>('unavailable');
  const [backendInfo, setBackendInfo] = useState<BackendInfo>({
    available: ['pocket-tts'],
    active: 'pocket-tts',
    supports_tags: false,
  });

  // When switching to fish-speech, predefined voices won't work — auto-select first saved voice
  const handleBackendChange = useCallback((info: BackendInfo) => {
    setBackendInfo(info);
    if (info.active === 'fish-speech') {
      const isPredefined = !selectedVoice.startsWith('saved:') && selectedVoice !== 'custom';
      if (isPredefined && savedVoices.length > 0) {
        setSelectedVoice(`saved:${savedVoices[0].id}`);
      } else if (isPredefined && savedVoices.length === 0) {
        // No saved voices available — user will see an error when they try to generate
        setSelectedVoice('');
      }
    }
  }, [selectedVoice, savedVoices]);

  const [fishParams, setFishParams] = useState<FishGenParams>({ temperature: 0.7, topP: 0.7, topK: 30 });
  const [isPaused, setIsPaused] = useState(false);

  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const playerRef = useRef<StreamingWavPlayer | null>(null);
  const startTimeRef = useRef<number>(0);
  const [pendingMultiConfig, setPendingMultiConfig] = useState<MultiTalkConfig | null>(null);

  // Load saved voices and check enhancement availability on startup
  useEffect(() => {
    window.electronAPI?.getSavedVoices().then(setSavedVoices);
    window.electronAPI?.isEnhanceAvailable?.().then(setEnhanceStatus).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      window.electronAPI?.removeAllListeners();
      playerRef.current?.stop();
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!text.trim()) return;

    // Reset state
    setGenerationState({
      status: 'generating',
      timeToFirstAudio: null,
      totalTime: null,
      error: null,
      statusMessage: null,
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
        let voiceName = selectedVoice;
        if (selectedVoice.startsWith('saved:')) {
          const saved = savedVoices.find((v) => `saved:${v.id}` === selectedVoice);
          if (saved) voiceName = saved.name;
        } else if (selectedVoice !== 'custom') {
          const predefined = PREDEFINED_VOICES.find((v) => v.id === selectedVoice);
          if (predefined) voiceName = predefined.name;
        }
        addToHistory({
          type: 'single',
          text,
          voice: selectedVoice,
          voiceName,
          backend: backendInfo.active || undefined,
          fishTemperature: backendInfo.active === 'fish-speech' ? fishParams.temperature : undefined,
          fishTopP: backendInfo.active === 'fish-speech' ? fishParams.topP : undefined,
          fishTopK: backendInfo.active === 'fish-speech' ? fishParams.topK : undefined,
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

    window.electronAPI.onTTSStatus?.((message) => {
      setGenerationState((prev) => ({
        ...prev,
        statusMessage: message,
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

    // Prepare TTS parameters
    let voiceFile: ArrayBuffer | undefined;
    let voiceUrl: string | undefined;
    let savedVoiceId: string | undefined;
    let rmsTargetDb: number | undefined;

    if (customAudioFile) {
      voiceFile = await customAudioFile.arrayBuffer();
    } else if (selectedVoice.startsWith('saved:')) {
      savedVoiceId = selectedVoice.replace('saved:', '');
      // Look up per-voice normalization setting
      const saved = savedVoices.find((v) => v.id === savedVoiceId);
      rmsTargetDb = saved?.audioNormalization?.rmsTargetDb;
    } else if (selectedVoice !== 'custom') {
      voiceUrl = selectedVoice;
    }

    // Start generation
    try {
      await window.electronAPI.generateTTS({
        text,
        voiceUrl,
        voiceFile,
        savedVoiceId,
        rmsTargetDb,
        fishTemperature: fishParams.temperature,
        fishTopP: fishParams.topP,
        fishTopK: fishParams.topK,
      });
    } catch (error) {
      setGenerationState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }, [text, selectedVoice, customAudioFile, savedVoices]);

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

  const handleVoiceChange = useCallback((voice: string) => {
    setSelectedVoice(voice);
    if (voice !== 'custom' && !voice.startsWith('saved:')) {
      setCustomAudioFile(null);
    }
  }, []);

  const handleCustomAudio = useCallback((file: File | null) => {
    setCustomAudioFile(file);
    if (file) {
      setSelectedVoice('custom');
      // Show modal to optionally save the voice
      setShowSaveVoiceModal(true);
    }
  }, []);

  const handleSaveVoice = useCallback(async (name: string, description: string, enhanceAfterSave: boolean) => {
    if (!customAudioFile) return;

    const audioData = await customAudioFile.arrayBuffer();
    const savedVoice = await window.electronAPI.saveVoice({
      name,
      description,
      audioData,
    });

    setSavedVoices((prev) => [...prev, savedVoice]);
    setSelectedVoice(`saved:${savedVoice.id}`);
    setCustomAudioFile(null);

    // Open Enhancement Studio if requested
    if (enhanceAfterSave) {
      setEnhancementTargetVoiceId(savedVoice.id);
      setShowEnhancementStudio(true);
    }
  }, [customAudioFile]);

  const handleDeleteSavedVoice = useCallback(async (id: string) => {
    await window.electronAPI.deleteVoice(id);
    setSavedVoices((prev) => prev.filter((v) => v.id !== id));
    setSelectedVoice('alba');
  }, []);

  const [enhancementEditMode, setEnhancementEditMode] = useState(false);

  const handleEnhanceVoice = useCallback((id: string) => {
    setEnhancementTargetVoiceId(id);
    setEnhancementEditMode(false);
    setShowEnhancementStudio(true);
  }, []);

  const handleEditEnhancement = useCallback((id: string) => {
    setEnhancementTargetVoiceId(id);
    setEnhancementEditMode(true);
    setShowEnhancementStudio(true);
  }, []);

  const handleEnhancementAccepted = useCallback((updatedVoice: SavedVoice) => {
    setSavedVoices((prev) =>
      prev.map((v) => (v.id === updatedVoice.id ? updatedVoice : v))
    );
  }, []);

  const handleInsertPause = useCallback((duration: number) => {
    const formatted = parseFloat(duration.toFixed(1)).toString();
    const marker = `[${formatted}s]`;
    const start = textInputRef.current?.selectionStart ?? text.length;
    const end = textInputRef.current?.selectionEnd ?? text.length;
    const newText = text.slice(0, start) + marker + text.slice(end);
    setText(newText);
    setTimeout(() => {
      textInputRef.current?.focus();
      textInputRef.current?.setSelectionRange(start + marker.length, start + marker.length);
    }, 0);
  }, [text]);

  // History reuse handlers
  const handleReuseSingle = useCallback((entry: HistoryEntry) => {
    if (entry.text) setText(entry.text);
    if (entry.voice) setSelectedVoice(entry.voice);
    setCustomAudioFile(null);
    // Restore fish params if they were saved
    if (entry.fishTemperature !== undefined) {
      setFishParams({
        temperature: entry.fishTemperature,
        topP: entry.fishTopP ?? 0.7,
        topK: entry.fishTopK ?? 30,
      });
    }
    // Switch backend if needed
    if (entry.backend && entry.backend !== backendInfo.active) {
      window.electronAPI?.switchBackend(entry.backend).catch(() => {});
    }
    setActiveTab('single');
  }, [backendInfo.active]);

  const handleReuseMulti = useCallback((entry: HistoryEntry) => {
    if (entry.script && entry.speakers) {
      setPendingMultiConfig({
        script: entry.script,
        speakers: entry.speakers,
      });
    }
    setActiveTab('multi');
  }, []);

  const handleMultiConfigLoaded = useCallback(() => {
    setPendingMultiConfig(null);
  }, []);

  const isGenerating = generationState.status === 'generating' || generationState.status === 'streaming';

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Drag region for macOS with dev tools toggle */}
      <div className="h-8 drag-region relative">
        <button
          onClick={() => window.electronAPI?.toggleDevTools()}
          className="absolute right-2 top-1 no-drag text-text-secondary/40 hover:text-text-secondary text-xs px-1.5 py-0.5 rounded transition-colors"
          title="Toggle Developer Tools"
        >
          DEV
        </button>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-8">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-text-primary">Pocket TTS</h1>
          <p className="text-sm text-text-secondary mt-1">
            High-quality text-to-speech that runs on your CPU
          </p>
        </div>



        {/* Tab Navigation */}
        <div className="flex border-b border-border-color mb-6">
          <button
            onClick={() => setActiveTab('single')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors
              ${activeTab === 'single'
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
          >
            Single Voice
          </button>
          <button
            onClick={() => setActiveTab('multi')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors
              ${activeTab === 'multi'
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
          >
            Multi-Talk
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors
              ${activeTab === 'history'
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
          >
            History
          </button>
        </div>

        {/* Single Voice Tab */}
        {activeTab === 'single' && (
          <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 180px)' }}>
            {/* Two-Column Layout */}
            <div className="flex gap-6 flex-1 min-h-0">

              {/* Left Column: Reference Audio + Voice + Controls */}
              <div className="w-[380px] flex-shrink-0 flex flex-col space-y-4">
                {/* Reference Audio Section */}
                <ReferenceAudio
                  onFileSelect={handleCustomAudio}
                  selectedFile={customAudioFile}
                  disabled={isGenerating}
                />

                {/* Model Selector */}
                <BackendSelector
                  disabled={isGenerating}
                  onBackendChange={handleBackendChange}
                  fishParams={fishParams}
                  onFishParamsChange={setFishParams}
                />

                {/* Voice Selector */}
                <VoiceSelector
                  selectedVoice={selectedVoice}
                  onVoiceChange={handleVoiceChange}
                  hasCustomAudio={!!customAudioFile}
                  disabled={isGenerating}
                  savedVoices={savedVoices}
                  onDeleteSavedVoice={handleDeleteSavedVoice}
                  onEnhanceVoice={handleEnhanceVoice}
                  onEditEnhancement={handleEditEnhancement}
                  enhanceStatus={enhanceStatus}
                  onEnhanceStatusChange={setEnhanceStatus}
                  hidePredefinedVoices={backendInfo.active === 'fish-speech'}
                />

                {/* Synthesize / Playback Controls */}
                <SynthesizeButton
                  onClick={handleGenerate}
                  onStop={handleStop}
                  onPause={handlePause}
                  onResume={handleResume}
                  status={generationState.status}
                  isPaused={isPaused}
                  disabled={!text.trim()}
                />

                {/* Status Indicator */}
                <StatusIndicator
                  status={generationState.status}
                  timeToFirstAudio={generationState.timeToFirstAudio}
                  totalTime={generationState.totalTime}
                  error={generationState.error}
                  isPaused={isPaused}
                  statusMessage={generationState.statusMessage}
                />

                {/* Audio Player */}
                {audioBlob && (
                  <div>
                    <AudioPlayer audioBlob={audioBlob} />
                  </div>
                )}
              </div>

              {/* Right Column: Text Input (fills remaining width and height) */}
              <div className="flex-1 flex flex-col min-w-0 pb-6">
                <div className="bg-bg-secondary rounded-lg p-4 flex flex-col flex-1">
                  <div className="flex items-center justify-between mb-3">
                    <label className="block text-sm font-medium text-text-primary">
                      Text to Generate
                    </label>
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
                  <textarea
                    ref={textInputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={isGenerating}
                    placeholder="Enter the text you want to convert to speech..."
                    className={`w-full flex-1 bg-bg-tertiary text-text-primary border border-border-color rounded-lg px-4 py-3 text-sm
                      placeholder-text-secondary resize-none min-h-[900px]
                      focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent
                      ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                  <div className="mt-2 flex justify-between text-xs text-text-secondary">
                    <span>{text.trim().split(/\s+/).filter(Boolean).length} words</span>
                    <span>{text.length} characters</span>
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* Multi-Talk Tab */}
        {activeTab === 'multi' && (
          <MultiTalk
            pendingConfig={pendingMultiConfig}
            onConfigLoaded={handleMultiConfigLoaded}
            onBackendChange={handleBackendChange}
            backendName={backendInfo.active}
            fishParams={fishParams}
            onFishParamsChange={setFishParams}
          />
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div>
            <History
              onReuseSingle={handleReuseSingle}
              onReuseMulti={handleReuseMulti}
            />
          </div>
        )}
      </div>

      {/* Save Voice Modal */}
      <SaveVoiceModal
        isOpen={showSaveVoiceModal}
        onClose={() => setShowSaveVoiceModal(false)}
        onSave={handleSaveVoice}
        fileName={customAudioFile?.name ?? 'Unknown'}
        enhanceStatus={enhanceStatus}
        onEnhanceStatusChange={setEnhanceStatus}
      />

      {/* Enhancement Studio Modal */}
      <EnhancementStudio
        isOpen={showEnhancementStudio}
        onClose={() => {
          setShowEnhancementStudio(false);
          setEnhancementTargetVoiceId(null);
          setEnhancementEditMode(false);
        }}
        voiceId={enhancementTargetVoiceId}
        voiceName={
          enhancementTargetVoiceId
            ? savedVoices.find((v) => v.id === enhancementTargetVoiceId)?.name ?? null
            : null
        }
        onAccepted={handleEnhancementAccepted}
        editMode={enhancementEditMode}
        initialDenoise={
          enhancementEditMode && enhancementTargetVoiceId
            ? savedVoices.find((v) => v.id === enhancementTargetVoiceId)?.enhanced?.denoise
            : undefined
        }
        initialRmsTargetDb={
          enhancementEditMode && enhancementTargetVoiceId
            ? savedVoices.find((v) => v.id === enhancementTargetVoiceId)?.audioNormalization?.rmsTargetDb
            : undefined
        }
      />

      {/* Pause Insert Modal */}
      <PauseModal
        isOpen={showPauseModal}
        onClose={() => setShowPauseModal(false)}
        onInsert={handleInsertPause}
      />
    </div>
  );
}
