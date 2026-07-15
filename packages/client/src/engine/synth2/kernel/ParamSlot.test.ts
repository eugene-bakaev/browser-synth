import { describe, it, expect } from 'vitest';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;
const lin: Synth2ParamDescriptor = {
  key: 't.lin', min: 0, max: 1, default: 0.5, taper: 'linear', modulatable: true, modScale: 1, label: 'Test',
};
const exp: Synth2ParamDescriptor = {
  key: 't.exp', min: 20, max: 20000, default: 1000, taper: 'expOctaves', modulatable: true, modScale: 4, label: 'Test',
};

describe('ParamSlot', () => {
  it('starts at the descriptor default', () => {
    expect(new ParamSlot(lin, SR).next()).toBeCloseTo(0.5, 3);
  });

  it('smooths a base jump over ~5ms (no instant step)', () => {
    const s = new ParamSlot(lin, SR);
    s.setBase(1);
    const first = s.next();
    expect(first).toBeLessThan(0.51); // one sample in: barely moved
    for (let i = 0; i < SR * 0.05; i++) s.next(); // 50ms ≫ 5ms smoother
    expect(s.next()).toBeCloseTo(1, 3);
  });

  it('clamps setBase to the descriptor range', () => {
    const s = new ParamSlot(lin, SR);
    s.setBase(99);
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(1, 3);
  });

  it('applies linear modulation as fraction of full range, clamped', () => {
    const s = new ParamSlot(lin, SR);
    s.mod = 0.25; // +25% of (max-min) = +0.25
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(0.75, 3);
    s.mod = 10; // way over — clamps to max
    expect(s.next()).toBeCloseTo(1, 3);
  });

  it('applies expOctaves modulation multiplicatively', () => {
    const s = new ParamSlot(exp, SR);
    s.mod = 0.25; // 0.25 × 4 octaves = +1 octave
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(2000, 0);
  });

  it('applies negative linear mod and clamps to min', () => {
    const s = new ParamSlot(lin, SR);
    // default base=0.5, mod=-0.25 → 0.5 + (-0.25 × 1 × 1) = 0.25
    s.mod = -0.25;
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(0.25, 3);
    // large negative mod → clamps to min=0
    s.mod = -10;
    expect(s.next()).toBeCloseTo(0, 3);
  });

  it('expOctaves negative mod shifts down and clamps to min', () => {
    const s = new ParamSlot(exp, SR);
    // default base=1000, mod=-1 → 1000 × 2^(-1×4) = 1000/16 = 62.5
    s.mod = -1;
    for (let i = 0; i < SR * 0.05; i++) s.next();
    expect(s.next()).toBeCloseTo(62.5, 0);
    // base at min=20, mod=-1 → 20 × 2^-4 = 1.25 → clamped up to min=20
    s.mod = 0;
    s.setBase(20);
    for (let i = 0; i < SR * 0.05; i++) s.next();
    s.mod = -1;
    expect(s.next()).toBeCloseTo(20, 1);
  });

  it('mod applies to the settled (smoothed) base, not the default', () => {
    const s = new ParamSlot(lin, SR);
    s.setBase(0.8);
    // settle ~50ms with mod=0
    for (let i = 0; i < SR * 0.05; i++) s.next();
    // now apply mod=0.1 → 0.8 + 0.1 × 1 × 1 = 0.9
    s.mod = 0.1;
    expect(s.next()).toBeCloseTo(0.9, 3);
  });

  // I4: the descriptor clamp must be NaN-safe. A non-finite base or mod (garbage
  // param input) must never leak a non-finite value — the spec §3 robustness
  // surface assumes ParamSlot makes param values finite and in-range.
  it('coerces a non-finite base to a finite in-range value (NaN -> min)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const s = new ParamSlot(lin, SR);
      s.setBase(bad);
      for (let i = 0; i < SR * 0.05; i++) {
        const v = s.next();
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(lin.min);
        expect(v).toBeLessThanOrEqual(lin.max);
      }
    }
  });

  it('coerces a non-finite mod to a finite in-range output', () => {
    const s = new ParamSlot(lin, SR);
    s.mod = NaN;
    expect(Number.isFinite(s.next())).toBe(true);
    s.mod = Infinity;
    expect(Number.isFinite(s.next())).toBe(true);
  });
});
