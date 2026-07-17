import { describe, expect, it } from 'vitest';
import { bandEnergyRatio } from './bands';

// 1024 bins at ~21.5Hz/bin ≈ a 44.1kHz / 2048-point analysis.
const FLOOR = -100;
const spectrumWithPeak = (hz: number, binHz = 21.533): number[] => {
  const bins = new Array(1024).fill(FLOOR);
  bins[Math.round(hz / binHz)] = 0; // 0dB single-bin peak
  return bins;
};

describe('bandEnergyRatio', () => {
  it('a 100Hz peak lands in lo', () => {
    expect(bandEnergyRatio(spectrumWithPeak(100), 21.533).lo).toBeGreaterThan(0.9);
  });
  it('a 1kHz peak lands in mid', () => {
    expect(bandEnergyRatio(spectrumWithPeak(1000), 21.533).mid).toBeGreaterThan(0.9);
  });
  it('a 5kHz peak lands in hi', () => {
    expect(bandEnergyRatio(spectrumWithPeak(5000), 21.533).hi).toBeGreaterThan(0.9);
  });
  it('ratios sum to ~1 for any non-silent spectrum', () => {
    const r = bandEnergyRatio(spectrumWithPeak(1000), 21.533);
    expect(r.lo + r.mid + r.hi).toBeCloseTo(1, 6);
  });
});
