import { describe, it, expect } from 'vitest';
import { analyzeEnvelope, db } from './envelope';
import type { AudioClip } from '../types';

const SR = 48000;

/** silence, then a sine burst with a sharp start, then silence again. */
function burstClip(bursts: { start: number; dur: number; amp: number }[], total: number): AudioClip {
  const samples = new Float32Array(Math.round(total * SR));
  for (const b of bursts) {
    const s = Math.round(b.start * SR);
    const n = Math.round(b.dur * SR);
    for (let i = 0; i < n; i++) {
      samples[s + i] = b.amp * Math.sin((2 * Math.PI * 440 * i) / SR);
    }
  }
  return { samples, sampleRate: SR };
}

describe('analyzeEnvelope', () => {
  it('reports whole-clip peak and per-hop points', () => {
    const clip = burstClip([{ start: 0.2, dur: 0.3, amp: 0.5 }], 1.0);
    const env = analyzeEnvelope(clip);
    expect(env.peakDb).toBeCloseTo(db(0.5), 0);
    expect(env.points.length).toBe(Math.floor(clip.samples.length / Math.round(0.005 * SR)));
    // a hop inside the burst is loud; one inside leading silence is at the floor
    expect(env.points[Math.round(0.3 / 0.005)].rmsDb).toBeGreaterThan(-12);
    expect(env.points[10].rmsDb).toBe(-Infinity);
  });

  it('detects one onset per burst at the right time', () => {
    const clip = burstClip(
      [{ start: 0.2, dur: 0.2, amp: 0.5 }, { start: 0.6, dur: 0.2, amp: 0.5 }],
      1.0,
    );
    const env = analyzeEnvelope(clip);
    expect(env.onsets.length).toBe(2);
    expect(env.onsets[0]).toBeGreaterThan(0.18);
    expect(env.onsets[0]).toBeLessThan(0.22);
    expect(env.onsets[1]).toBeGreaterThan(0.58);
    expect(env.onsets[1]).toBeLessThan(0.62);
  });

  it('measures decay time to -40dB below peak', () => {
    // 0.5s exponential decay from amp 0.8 with tau=0.05s: -40dB at t≈0.23s
    const n = Math.round(0.5 * SR);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.8 * Math.exp(-i / SR / 0.05) * Math.sin((2 * Math.PI * 200 * i) / SR);
    }
    const env = analyzeEnvelope({ samples, sampleRate: SR });
    expect(env.decaySeconds).not.toBeNull();
    expect(env.decaySeconds!).toBeGreaterThan(0.15);
    expect(env.decaySeconds!).toBeLessThan(0.3);
  });

  it('returns null attack/decay for silence and finds no onsets', () => {
    const env = analyzeEnvelope({ samples: new Float32Array(SR), sampleRate: SR });
    expect(env.onsets).toEqual([]);
    expect(env.attackSeconds).toBeNull();
    expect(env.decaySeconds).toBeNull();
    expect(env.peakDb).toBe(-Infinity);
  });
});
