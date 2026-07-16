import { describe, it, expect } from 'vitest';
import { analyzeHealth } from './health';
import type { AudioClip } from '../types';

const SR = 48000;

function clipOf(fill: (i: number) => number, seconds = 0.5): AudioClip {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = fill(i);
  return { samples, sampleRate: SR };
}

describe('analyzeHealth', () => {
  it('clean sine has no flags', () => {
    const h = analyzeHealth(clipOf((i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)));
    expect(h.clippedSamples).toBe(0);
    expect(h.nonFiniteSamples).toBe(0);
    expect(Math.abs(h.dcOffset)).toBeLessThan(0.001);
    expect(h.flags).toEqual([]);
  });

  it('counts clipped and non-finite samples and flags them', () => {
    const samples = new Float32Array(SR);
    samples.fill(0.5);
    samples[100] = 1.0;
    samples[200] = -1.0;
    samples[300] = NaN;
    samples[400] = Infinity;
    const h = analyzeHealth({ samples, sampleRate: SR });
    expect(h.clippedSamples).toBe(2);
    expect(h.nonFiniteSamples).toBe(2);
    expect(h.flags).toContain('CLIPPING');
    expect(h.flags).toContain('NON_FINITE');
  });

  it('flags DC offset', () => {
    const h = analyzeHealth(clipOf(() => 0.1));
    expect(h.dcOffset).toBeCloseTo(0.1, 3);
    expect(h.flags).toContain('DC_OFFSET');
  });

  it('measures longest silence and flags a mostly-silent clip', () => {
    // 1s clip: sound only in the first 0.1s
    const h = analyzeHealth(
      clipOf((i) => (i < 0.1 * SR ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0), 1.0),
    );
    expect(h.longestSilenceSeconds).toBeGreaterThan(0.85);
    expect(h.flags).toContain('MOSTLY_SILENT');
  });
});
