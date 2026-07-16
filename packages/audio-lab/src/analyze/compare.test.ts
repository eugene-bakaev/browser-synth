import { describe, it, expect } from 'vitest';
import { compareReports } from './compare';
import { buildReport } from '../report/report';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 0.5): AudioClip {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

describe('compareReports', () => {
  it('reports frequency and level deltas', () => {
    const a = buildReport(sine(220, 0.5, 0.25));
    const b = buildReport(sine(440, 0.5, 0.5));
    const c = compareReports(a, b);
    expect(c.metrics.medianF0.delta).toBeCloseTo(220, -1);
    expect(c.metrics.peakDb.delta).toBeCloseTo(6, 0);
    expect(c.metrics.onsetCount.a).toBe(1);
  });

  it('null-safe when one side is silent', () => {
    const a = buildReport({ samples: new Float32Array(SR / 10), sampleRate: SR });
    const b = buildReport(sine(440, 0.5));
    const c = compareReports(a, b);
    expect(c.metrics.medianF0.a).toBeNull();
    expect(c.metrics.medianF0.delta).toBeNull();
    expect(c.notes.join(' ')).toMatch(/MOSTLY_SILENT/);
  });
});
