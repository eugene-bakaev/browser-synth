import { describe, it, expect } from 'vitest';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;
const lin: Synth2ParamDescriptor = {
  key: 't.lin', min: 0, max: 1, default: 0.5, taper: 'linear', modulatable: true, modScale: 1,
};
const exp: Synth2ParamDescriptor = {
  key: 't.exp', min: 20, max: 20000, default: 1000, taper: 'expOctaves', modulatable: true, modScale: 4,
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
});
