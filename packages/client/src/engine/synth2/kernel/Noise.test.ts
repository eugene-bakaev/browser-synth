import { describe, it, expect } from 'vitest';
import { Noise } from './Noise';

describe('Noise', () => {
  it('is deterministic for a given seed', () => {
    const a = new Noise(12345), b = new Noise(12345);
    for (let i = 0; i < 100; i++) expect(a.next(1)).toBe(b.next(1)); // color 1 = white
  });

  it('different seeds diverge', () => {
    const a = new Noise(1), b = new Noise(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next(1) === b.next(1)) same++;
    expect(same).toBeLessThan(5);
  });

  it('white output stays within [-1, 1] and is roughly zero-mean', () => {
    const n = new Noise(99);
    let sum = 0, max = 0;
    for (let i = 0; i < 10000; i++) { const v = n.next(1); sum += v; max = Math.max(max, Math.abs(v)); }
    expect(max).toBeLessThanOrEqual(1);
    expect(Math.abs(sum / 10000)).toBeLessThan(0.05);
  });

  it('color < 1 lowpasses: less high-frequency energy than white', () => {
    // crude HF metric: mean |sample-to-sample difference|
    const white = new Noise(7), dark = new Noise(7);
    let dw = 0, dd = 0, pw = 0, pd = 0;
    for (let i = 0; i < 5000; i++) {
      const w = white.next(1); dw += Math.abs(w - pw); pw = w;
      const d = dark.next(0.02); dd += Math.abs(d - pd); pd = d;
    }
    expect(dd).toBeLessThan(dw); // dark has gentler sample-to-sample motion
  });
});
