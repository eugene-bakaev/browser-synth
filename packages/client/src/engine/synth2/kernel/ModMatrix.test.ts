import { describe, it, expect } from 'vitest';
import { ModMatrix } from './ModMatrix.js';

// Minimal slot stub: only `.mod` matters to the matrix.
const slots = (n: number) => Array.from({ length: n }, () => ({ mod: 0 }));

describe('ModMatrix (I3a)', () => {
  it('clears all slot mods when no routes are active', () => {
    const s = slots(3); s[0].mod = 99;
    const m = new ModMatrix();
    m.apply(s as never, new Float32Array(8));
    expect(s[0].mod).toBe(0);
  });

  it('writes source × amount into the destination slot', () => {
    const s = slots(3);
    const m = new ModMatrix();
    m.setSlot(0, /*src*/ 3, /*destSlot*/ 1, /*amount*/ 0.5);
    const src = new Float32Array(8); src[3] = 0.8; // env1-ish
    m.apply(s as never, src);
    expect(s[1].mod).toBeCloseTo(0.4, 6);
    expect(s[0].mod).toBe(0);
  });

  it('sums multiple routes to one destination before the slot clamps', () => {
    const s = slots(3);
    const m = new ModMatrix();
    m.setSlot(0, 3, 1, 0.5);
    m.setSlot(1, 6, 1, -0.25);
    const src = new Float32Array(8); src[3] = 1; src[6] = 1;
    m.apply(s as never, src);
    expect(s[1].mod).toBeCloseTo(0.25, 6);
  });

  it('ignores dest = none (-1) and amount = 0', () => {
    const s = slots(3);
    const m = new ModMatrix();
    m.setSlot(0, 3, -1, 0.9);
    m.setSlot(1, 3, 2, 0);
    const src = new Float32Array(8); src[3] = 1;
    m.apply(s as never, src);
    expect(s[2].mod).toBe(0);
  });

  it('re-clears each apply (no accumulation across samples)', () => {
    const s = slots(2);
    const m = new ModMatrix();
    m.setSlot(0, 3, 0, 1);
    const src = new Float32Array(8); src[3] = 0.5;
    m.apply(s as never, src);
    m.apply(s as never, src);
    expect(s[0].mod).toBeCloseTo(0.5, 6); // not 1.0
  });
});
