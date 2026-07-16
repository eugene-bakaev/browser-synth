import { describe, it, expect } from 'vitest';
import { encodeWav, decodeWav } from './wav';
import type { AudioClip } from '../types';

function sine(freq: number, seconds: number, sampleRate: number, amp = 0.5): AudioClip {
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return { samples, sampleRate };
}

describe('wav codec', () => {
  it('round-trips a mono 16-bit clip within quantization error', () => {
    const clip = sine(440, 0.1, 48000);
    const bytes = encodeWav(clip);
    // RIFF header sanity
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF');
    expect(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])).toBe('WAVE');
    expect(bytes.length).toBe(44 + clip.samples.length * 2);

    const back = decodeWav(bytes);
    expect(back.sampleRate).toBe(48000);
    expect(back.samples.length).toBe(clip.samples.length);
    for (let i = 0; i < clip.samples.length; i += 97) {
      expect(Math.abs(back.samples[i] - clip.samples[i])).toBeLessThan(1 / 32000);
    }
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const clip: AudioClip = { samples: new Float32Array([1.5, -1.5]), sampleRate: 48000 };
    const back = decodeWav(encodeWav(clip));
    expect(back.samples[0]).toBeGreaterThan(0.99);
    expect(back.samples[1]).toBeLessThan(-0.99);
  });

  it('rejects non-PCM16-mono files', () => {
    const bytes = encodeWav(sine(440, 0.01, 48000));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(22, 2, true); // pretend stereo
    expect(() => decodeWav(bytes)).toThrow(/mono/i);
  });
});
