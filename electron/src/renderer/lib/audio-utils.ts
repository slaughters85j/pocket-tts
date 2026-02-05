/**
 * Convert any audio file/blob to WAV format using Web Audio API
 */
export async function convertToWav(audioBlob: Blob): Promise<Blob> {
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBufferToWav(audioBuffer);
  } finally {
    await audioContext.close();
  }
}

/**
 * Convert AudioBuffer to WAV Blob
 */
function audioBufferToWav(audioBuffer: AudioBuffer): Blob {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;

  // Interleave channels
  const length = audioBuffer.length * numChannels;
  const interleaved = new Float32Array(length);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < audioBuffer.length; i++) {
      interleaved[i * numChannels + channel] = channelData[i];
    }
  }

  // Convert to 16-bit PCM
  const dataLength = length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write PCM data
  let offset = 44;
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, interleaved[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Check if a blob is already a valid WAV file
 */
export async function isValidWav(blob: Blob): Promise<boolean> {
  if (blob.size < 44) return false;

  const header = await blob.slice(0, 12).arrayBuffer();
  const view = new Uint8Array(header);

  const riff = String.fromCharCode(view[0], view[1], view[2], view[3]);
  const wave = String.fromCharCode(view[8], view[9], view[10], view[11]);

  return riff === 'RIFF' && wave === 'WAVE';
}

/**
 * Ensure audio is in WAV format, converting if necessary
 */
export async function ensureWavFormat(file: File): Promise<File> {
  // Check if already WAV
  if (await isValidWav(file)) {
    return file;
  }

  // Convert to WAV
  const wavBlob = await convertToWav(file);
  return new File([wavBlob], file.name.replace(/\.[^.]+$/, '.wav'), {
    type: 'audio/wav',
  });
}
