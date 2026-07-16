// Hand-rolled 16-bit PCM mono WAV, little-endian. 44-byte canonical header on
// encode; decode walks chunks so files with extra chunks (LIST etc.) still load.
import type { AudioClip } from '../types';

export function encodeWav(clip: AudioClip): Uint8Array {
  const { samples, sampleRate } = clip;
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);      // fmt chunk size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes: Uint8Array): AudioClip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (off: number, len: number) =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('not a WAV file');

  let sampleRate = 0;
  let samples: Float32Array | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      const format = view.getUint16(off + 8, true);
      const channels = view.getUint16(off + 10, true);
      const bits = view.getUint16(off + 22, true);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error('only PCM 16-bit mono WAV is supported');
      }
      sampleRate = view.getUint32(off + 12, true);
    } else if (id === 'data') {
      const n = Math.floor(size / 2);
      samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = view.getInt16(off + 8 + i * 2, true);
        samples[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
      }
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!sampleRate || !samples) throw new Error('WAV missing fmt or data chunk');
  return { samples, sampleRate };
}
