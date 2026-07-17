import { describe, it, expect } from 'vitest';
import { Glide } from './Glide';

const SR = 48000;

describe('Glide (portamento, spec 2026-07-16)', () => {
  it('first-ever note snaps (no previous pitch to glide from)', () => {
    const g = new Glide(SR);
    g.noteOn(440, true);
    expect(g.next(440, 0.5)).toBe(440);
  });

  it('mono note glides from the previous pitch: starts there, lands exactly on target and stays', () => {
    const g = new Glide(SR);
    g.noteOn(220, true);
    g.noteOn(440, true); // one octave up — glide begins
    const first = g.next(440, 0.5);
    expect(first).toBeGreaterThan(219); // ≈220: one octave below target, one sample in
    expect(first).toBeLessThan(222);
    let v = first;
    for (let i = 1; i < 0.5 * SR; i++) v = g.next(440, 0.5);
    expect(v).toBe(440);
    expect(g.next(440, 0.5)).toBe(440);
  });

  it('constant-time law: any interval completes in glideSeconds', () => {
    for (const target of [440, 880, 233.08]) { // 1 oct up, 2 oct up, odd interval
      const g = new Glide(SR);
      g.noteOn(220, true);
      g.noteOn(target, true);
      let samples = 0;
      while (g.next(target, 0.25) !== target) samples++;
      expect(samples).toBeGreaterThan(0.25 * SR - 10);
      expect(samples).toBeLessThan(0.25 * SR + 10);
    }
  });

  it('downward glide decreases monotonically and never undershoots the target', () => {
    const g = new Glide(SR);
    g.noteOn(880, true);
    g.noteOn(110, true);
    let prev = Infinity;
    for (let i = 0; i < 1000; i++) {
      const v = g.next(110, 0.5);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThanOrEqual(110);
      prev = v;
    }
  });

  it('poly note (mono=false) snaps but still updates the pitch memory', () => {
    const g = new Glide(SR);
    g.noteOn(220, true);
    g.noteOn(880, false);               // poly: snap
    expect(g.next(880, 0.5)).toBe(880);
    g.noteOn(220, true);                // mono again: glides from 880, not 220
    const first = g.next(220, 0.5);
    expect(first).toBeGreaterThan(870);
  });

  it('same-pitch retrigger does not glide', () => {
    const g = new Glide(SR);
    g.noteOn(330, true);
    g.noteOn(330, true);
    expect(g.next(330, 2)).toBe(330);
  });

  it('retrigger mid-glide restarts from the previous note TARGET (deterministic)', () => {
    const g = new Glide(SR);
    g.noteOn(110, true);
    g.noteOn(220, true);
    for (let i = 0; i < 100; i++) g.next(220, 0.5); // partway up from 110
    g.noteOn(440, true); // latches from 220 (previous target), not the mid-glide pitch
    const first = g.next(440, 0.5);
    expect(first).toBeGreaterThan(219);
    expect(first).toBeLessThan(222);
  });
});
