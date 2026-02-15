export type StreamingWavPlayerEvents = {
  onFirstAudio?: () => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
};

export class StreamingWavPlayer {
  private audioContext: AudioContext;
  private sampleRate: number = 0;
  private numChannels: number = 0;
  private headerParsed: boolean = false;
  private headerBuffer: Uint8Array = new Uint8Array(44);
  private headerBytesReceived: number = 0;
  private nextStartTime: number = 0;
  private isPlaying: boolean = false;
  private minBufferSize: number = 16384;
  private pcmData: Uint8Array = new Uint8Array(0);
  private firstAudioPlayed: boolean = false;
  private events: StreamingWavPlayerEvents;
  private allChunks: Uint8Array[] = [];
  private stopped: boolean = false;

  constructor(events: StreamingWavPlayerEvents = {}) {
    this.audioContext = new AudioContext();
    this.events = events;
  }

  private parseWavHeader(header: Uint8Array): void {
    const view = new DataView(header.buffer);

    const riff = String.fromCharCode(...Array.from(header.slice(0, 4)));
    const wave = String.fromCharCode(...Array.from(header.slice(8, 12)));

    if (riff !== 'RIFF' || wave !== 'WAVE') {
      throw new Error('Invalid WAV file');
    }

    this.numChannels = view.getUint16(22, true);
    this.sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);

    console.log(`WAV Format: ${this.sampleRate}Hz, ${this.numChannels} channels, ${bitsPerSample} bits`);

    this.headerParsed = true;
  }

  private appendPcmData(newData: Uint8Array): void {
    const newBuffer = new Uint8Array(this.pcmData.length + newData.length);
    newBuffer.set(this.pcmData);
    newBuffer.set(newData, this.pcmData.length);
    this.pcmData = newBuffer;
  }

  private async tryPlayBuffer(): Promise<void> {
    if (this.stopped) return;
    if (!this.headerParsed || this.pcmData.length < this.minBufferSize) {
      return;
    }

    const bytesPerSample = this.numChannels * 2;
    const samplesToPlay = Math.floor(this.pcmData.length / bytesPerSample);
    const bytesToPlay = samplesToPlay * bytesPerSample;

    if (bytesToPlay === 0) return;

    const dataToPlay = this.pcmData.slice(0, bytesToPlay);
    this.pcmData = this.pcmData.slice(bytesToPlay);

    const audioBuffer = this.audioContext.createBuffer(
      this.numChannels,
      samplesToPlay,
      this.sampleRate
    );

    const int16Data = new Int16Array(
      dataToPlay.buffer,
      dataToPlay.byteOffset,
      samplesToPlay * this.numChannels
    );

    for (let channel = 0; channel < this.numChannels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let i = 0; i < samplesToPlay; i++) {
        channelData[i] = int16Data[i * this.numChannels + channel] / 32768;
      }
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const currentTime = this.audioContext.currentTime;
    const startTime = Math.max(currentTime, this.nextStartTime);

    source.start(startTime);

    if (!this.firstAudioPlayed) {
      this.firstAudioPlayed = true;
      this.events.onFirstAudio?.();
    }

    this.nextStartTime = startTime + audioBuffer.duration;
    this.isPlaying = true;

    if (this.pcmData.length >= this.minBufferSize) {
      setTimeout(() => this.tryPlayBuffer(), 10);
    }
  }

  addChunk(chunk: Uint8Array): void {
    if (this.stopped) return;

    this.allChunks.push(new Uint8Array(chunk));

    if (!this.headerParsed) {
      const headerBytesNeeded = 44 - this.headerBytesReceived;
      const bytesToCopy = Math.min(headerBytesNeeded, chunk.length);

      this.headerBuffer.set(chunk.slice(0, bytesToCopy), this.headerBytesReceived);

      this.headerBytesReceived += bytesToCopy;

      if (this.headerBytesReceived >= 44) {
        this.parseWavHeader(this.headerBuffer);

        if (chunk.length > bytesToCopy) {
          this.appendPcmData(chunk.slice(bytesToCopy));
        }
      }
    } else {
      this.appendPcmData(chunk);
    }

    this.tryPlayBuffer();
  }

  async flushRemaining(): Promise<void> {
    if (this.stopped) return;
    if (this.pcmData.length > 0 && this.headerParsed) {
      this.minBufferSize = 0;
      await this.tryPlayBuffer();
    }

    // Don't fire onComplete until all scheduled audio has actually played.
    // The HTTP stream often finishes well before playback does (e.g. 1s generation → 8s audio).
    // Poll audioContext.currentTime which correctly freezes when paused (suspended).
    this.waitForPlaybackEnd();
  }

  /** Polls until all scheduled AudioBufferSourceNodes have finished playing. */
  private waitForPlaybackEnd(): void {
    if (this.stopped) return;

    const remaining = this.nextStartTime - this.audioContext.currentTime;
    if (remaining <= 0.05) {
      // All buffers have played (50ms tolerance for scheduling jitter)
      this.events.onComplete?.();
    } else {
      // Re-check at reasonable intervals. Cap at 200ms so stop() is responsive.
      setTimeout(() => this.waitForPlaybackEnd(), Math.min(remaining * 1000, 200));
    }
  }

  getAudioBlob(): Blob {
    const totalLength = this.allChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.allChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Fix WAV header with correct file sizes
    // Streaming WAV headers often have placeholder sizes that prevent duration detection
    if (totalLength >= 44) {
      const view = new DataView(combined.buffer);
      // Bytes 4-7: File size - 8 (RIFF chunk size)
      view.setUint32(4, totalLength - 8, true);
      // Bytes 40-43: Data chunk size (file size - 44 byte header)
      view.setUint32(40, totalLength - 44, true);
    }

    return new Blob([combined], { type: 'audio/wav' });
  }

  /** Pause audio playback. Data continues to buffer via addChunk(). */
  async pause(): Promise<void> {
    if (this.stopped) return;
    if (this.audioContext.state === 'running') {
      await this.audioContext.suspend();
    }
  }

  /** Resume audio playback after pause. Flushes any data buffered while paused. */
  async resume(): Promise<void> {
    if (this.stopped) return;
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      // Play any data that accumulated while paused
      this.tryPlayBuffer();
    }
  }

  /** Whether audio is currently paused. */
  get isPaused(): boolean {
    return !this.stopped && this.audioContext.state === 'suspended';
  }

  /** Stop playback permanently and release resources. */
  stop(): void {
    this.stopped = true;
    this.isPlaying = false;
    this.audioContext.close();
  }

  /** Whether stop() has been called. */
  get isStopped(): boolean {
    return this.stopped;
  }

  getSampleRate(): number {
    return this.sampleRate;
  }
}
