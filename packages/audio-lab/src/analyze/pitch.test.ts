import { describe, it, expect } from 'vitest';
import { analyzePitch, pitchSettleTime } from './pitch';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 0.5): AudioClip {
  const n = Math.round(seconds * SR);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

/** Linear glide from f0 to f1 over `glide` seconds, then holds f1. Phase-continuous. */
function glideClip(f0: number, f1: number, glide: number, total: number): AudioClip {
  const n = Math.round(total * SR);
  const samples = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = t >= glide ? f1 : f0 + ((f1 - f0) * t) / glide;
    phase += (2 * Math.PI * f) / SR;
    samples[i] = 0.5 * Math.sin(phase);
  }
  return { samples, sampleRate: SR };
}

describe('analyzePitch', () => {
  it('tracks a steady 440Hz sine within 1Hz', () => {
    const p = analyzePitch(sine(440, 1.0));
    expect(p.medianF0).not.toBeNull();
    expect(Math.abs(p.medianF0! - 440)).toBeLessThan(1);
    const voiced = p.frames.filter((f) => f.f0 !== null);
    expect(voiced.length).toBeGreaterThan(80);
    for (const f of voiced) expect(f.confidence).toBeGreaterThan(0.8);
  });

  it('returns null f0 for silence', () => {
    const p = analyzePitch({ samples: new Float32Array(SR), sampleRate: SR });
    expect(p.medianF0).toBeNull();
    expect(p.frames.every((f) => f.f0 === null)).toBe(true);
  });

  it('follows a 220→440 glide', () => {
    const p = analyzePitch(glideClip(220, 440, 0.5, 1.0));
    const at = (t: number) =>
      p.frames.reduce((best, f) => (Math.abs(f.time - t) < Math.abs(best.time - t) ? f : best));
    expect(Math.abs(at(0.08)!.f0! - 220 - (440 - 220) * (0.08 / 0.5))).toBeLessThan(15);
    expect(Math.abs(at(0.8)!.f0! - 440)).toBeLessThan(3);
    expect(p.minF0!).toBeLessThan(240);
    expect(p.maxF0!).toBeGreaterThan(420);
  });
});

describe('pitchSettleTime', () => {
  it('measures when a glide reaches its target', () => {
    const p = analyzePitch(glideClip(220, 440, 0.4, 1.0));
    const settle = pitchSettleTime(p.frames, 0, 440);
    expect(settle).not.toBeNull();
    expect(settle!).toBeGreaterThan(0.3);
    expect(settle!).toBeLessThan(0.5);
  });

  it('is ~immediate when there is no glide', () => {
    const p = analyzePitch(sine(440, 0.5));
    const settle = pitchSettleTime(p.frames, 0, 440);
    expect(settle).not.toBeNull();
    expect(settle!).toBeLessThan(0.08);
  });

  it('returns null when the target is never reached', () => {
    const p = analyzePitch(sine(220, 0.5));
    expect(pitchSettleTime(p.frames, 0, 440)).toBeNull();
  });
});
