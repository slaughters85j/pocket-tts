export type AudioFormat = 'wav' | 'mp3' | 'm4a';

interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  pcmData: Int16Array;
}

/** Parse a WAV blob into its raw PCM samples and metadata. */
function parseWav(data: Uint8Array): WavInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const riff = String.fromCharCode(data[0], data[1], data[2], data[3]);
  const wave = String.fromCharCode(data[8], data[9], data[10], data[11]);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV file');
  }

  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  // Find the 'data' sub-chunk (it's usually at byte 36, but may be offset)
  let dataOffset = 12;
  while (dataOffset < data.length - 8) {
    const chunkId = String.fromCharCode(
      data[dataOffset],
      data[dataOffset + 1],
      data[dataOffset + 2],
      data[dataOffset + 3]
    );
    const chunkSize = view.getUint32(dataOffset + 4, true);
    if (chunkId === 'data') {
      dataOffset += 8;
      const pcmData = new Int16Array(
        data.buffer,
        data.byteOffset + dataOffset,
        chunkSize / 2
      );
      return { sampleRate, numChannels, bitsPerSample, pcmData };
    }
    dataOffset += 8 + chunkSize;
  }

  // Fallback: assume data starts at byte 44
  const pcmData = new Int16Array(data.buffer, data.byteOffset + 44);
  return { sampleRate, numChannels, bitsPerSample, pcmData };
}

/** Deinterleave PCM samples into per-channel Int16Arrays. */
function deinterleave(pcm: Int16Array, numChannels: number): Int16Array[] {
  const numSamples = Math.floor(pcm.length / numChannels);
  const channels: Int16Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = pcm[i * numChannels + ch];
    }
    channels.push(channelData);
  }
  return channels;
}

/** Convert mono PCM to stereo by duplicating the channel. Returns interleaved Int16Array. */
function monoToStereoInterleaved(monoSamples: Int16Array): Int16Array {
  const stereo = new Int16Array(monoSamples.length * 2);
  for (let i = 0; i < monoSamples.length; i++) {
    stereo[i * 2] = monoSamples[i];
    stereo[i * 2 + 1] = monoSamples[i];
  }
  return stereo;
}

/** Build a stereo WAV blob from mono or stereo source data. */
export function toStereoWav(wavBlob: Blob): Promise<Blob> {
  return wavBlob.arrayBuffer().then((buf) => {
    const data = new Uint8Array(buf);
    const info = parseWav(data);

    // Already stereo — just return as-is
    if (info.numChannels >= 2) return wavBlob;

    const stereoPcm = monoToStereoInterleaved(info.pcmData);
    const numChannels = 2;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const dataLength = stereoPcm.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, info.sampleRate, true);
    view.setUint32(28, info.sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // PCM data
    const output = new Int16Array(buffer, 44);
    output.set(stereoPcm);

    return new Blob([buffer], { type: 'audio/wav' });
  });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Encode a WAV blob to MP3 using lamejs. Output is always stereo. */
export async function encodeToMp3(wavBlob: Blob, kbps: number = 192): Promise<Blob> {
  const { Mp3Encoder } = await import('lamejs');

  const data = new Uint8Array(await wavBlob.arrayBuffer());
  const info = parseWav(data);

  let leftChannel: Int16Array;
  let rightChannel: Int16Array;

  if (info.numChannels === 1) {
    leftChannel = info.pcmData;
    rightChannel = info.pcmData;
  } else {
    const channels = deinterleave(info.pcmData, info.numChannels);
    leftChannel = channels[0];
    rightChannel = channels[1] ?? channels[0];
  }

  const mp3Encoder = new Mp3Encoder(2, info.sampleRate, kbps);
  const mp3Chunks: Int8Array[] = [];

  const blockSize = 1152;
  const numSamples = leftChannel.length;

  for (let i = 0; i < numSamples; i += blockSize) {
    const end = Math.min(i + blockSize, numSamples);
    const leftBlock = leftChannel.subarray(i, end);
    const rightBlock = rightChannel.subarray(i, end);
    const mp3buf = mp3Encoder.encodeBuffer(leftBlock, rightBlock);
    if (mp3buf.length > 0) {
      mp3Chunks.push(new Int8Array(mp3buf));
    }
  }

  const tail = mp3Encoder.flush();
  if (tail.length > 0) {
    mp3Chunks.push(new Int8Array(tail));
  }

  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}

/** Encode a WAV blob to M4A (AAC) via the main process (ffmpeg/afconvert). */
export async function encodeToM4a(wavBlob: Blob): Promise<Blob> {
  // Convert to stereo WAV first, then send to main process for AAC encoding
  const stereoWav = await toStereoWav(wavBlob);
  const wavBuffer = await stereoWav.arrayBuffer();
  const m4aBuffer = await window.electronAPI.convertToM4a(wavBuffer);
  return new Blob([m4aBuffer], { type: 'audio/mp4' });
}

/** Check if M4A encoding is available (ffmpeg or macOS afconvert on the system). */
export async function isM4aSupported(): Promise<boolean> {
  try {
    return await window.electronAPI.isM4aAvailable();
  } catch {
    return false;
  }
}
