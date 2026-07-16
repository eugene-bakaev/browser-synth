import { describe, it, expect } from 'vitest';
import { analyzeSpectrum } from './spectrum';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 0.5): AudioClip {
  const n = Math.round(seconds * SR);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

describe('analyzeSpectrum', () => {
  it('puts the top spectral peak at the sine frequency', () => {
    const s = analyzeSpectrum(sine(440, 0.5));
    expect(s.binHz).toBeCloseTo(SR / 2048, 5);
    expect(s.peaks.length).toBeGreaterThan(0);
    expect(Math.abs(s.peaks[0].hz - 440)).toBeLessThanOrEqual(s.binHz);
  });

  it('centroid of a pure sine sits near the sine frequency', () => {
    const s = analyzeSpectrum(sine(440, 0.5));
    expect(s.meanCentroidHz).not.toBeNull();
    expect(Math.abs(s.meanCentroidHz! - 440)).toBeLessThan(40);
  });

  it('a brighter signal has a higher centroid', () => {
    const low = analyzeSpectrum(sine(200, 0.5)).meanCentroidHz!;
    const high = analyzeSpectrum(sine(2000, 0.5)).meanCentroidHz!;
    expect(high).toBeGreaterThan(low * 3);
  });

  it('spectrogram has the expected shape and silent frames are null-centroid', () => {
    const clip = sine(440, 0.3);
    const s = analyzeSpectrum(clip);
    expect(s.spectrogram.bins).toBe(1024);
    expect(s.spectrogram.frames).toBe(s.centroidHz.length);
    expect(s.spectrogram.db.length).toBe(s.spectrogram.frames * s.spectrogram.bins);

    const silent = analyzeSpectrum({ samples: new Float32Array(SR / 2), sampleRate: SR });
    expect(silent.meanCentroidHz).toBeNull();
    expect(silent.centroidHz.every((c) => c === null)).toBe(true);
  });
});
