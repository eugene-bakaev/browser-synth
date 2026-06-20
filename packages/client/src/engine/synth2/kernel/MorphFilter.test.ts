import { describe, it, expect } from 'vitest';
import { MorphFilter } from './MorphFilter.js';
import { SvfCore } from './SvfCore.js';

const SR = 48000;

// Drive a bare SvfCore identically to get reference low/band/high at the same sample.
function refOutputs(input: Float32Array, cutoff: number, res: number) {
  const svf = new SvfCore(SR);
  const low: number[] = [], band: number[] = [], high: number[] = [];
  for (let i = 0; i < input.length; i++) { svf.tick(input[i], cutoff, res); low.push(svf.low); band.push(svf.band); high.push(svf.high); }
  return { low, band, high };
}

function noise(n: number): Float32Array {
  const b = new Float32Array(n); let s = 12345;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = (s / 0x3fffffff) - 1; }
  return b;
}

describe('MorphFilter', () => {
  it('morph 0 = low, 1 = band, 2 = high (equal-power endpoints)', () => {
    const x = noise(2000);
    const ref = refOutputs(x, 1200, 0.4);
    const at = (m: number) => { const f = new MorphFilter(SR); const out: number[] = []; for (let i = 0; i < x.length; i++) out.push(f.process(x[i], 1200, 0.4, m)); return out; };
    const lo = at(0), bd = at(1), hi = at(2);
    for (let i = 0; i < x.length; i++) {
      expect(lo[i]).toBeCloseTo(ref.low[i], 10);
      expect(bd[i]).toBeCloseTo(ref.band[i], 10);
      expect(hi[i]).toBeCloseTo(ref.high[i], 10);
    }
  });

  it('morph 0.5 is the equal-power blend of low and band', () => {
    const x = noise(2000);
    const ref = refOutputs(x, 1200, 0.4);
    const f = new MorphFilter(SR);
    const g = Math.PI / 4; // 0.5 * pi/2
    for (let i = 0; i < x.length; i++) {
      const y = f.process(x[i], 1200, 0.4, 0.5);
      expect(y).toBeCloseTo(Math.cos(g) * ref.low[i] + Math.sin(g) * ref.band[i], 10);
    }
  });

  it('clamps morph outside 0..2', () => {
    const x = noise(500);
    const refLo = refOutputs(x, 1200, 0.4).low;
    const refHigh = refOutputs(x, 1200, 0.4).high;
    const f = new MorphFilter(SR);
    for (let i = 0; i < x.length; i++) expect(f.process(x[i], 1200, 0.4, -1)).toBeCloseTo(refLo[i], 10);
    const g = new MorphFilter(SR);
    for (let i = 0; i < x.length; i++) expect(g.process(x[i], 1200, 0.4, 3)).toBeCloseTo(refHigh[i], 10);
  });

  it('reset clears state (post-reset tick equals a fresh filter)', () => {
    const a = new MorphFilter(SR); const b = new MorphFilter(SR);
    for (let i = 0; i < 500; i++) a.process(Math.random() * 2 - 1, 1200, 0.5, 1);
    a.reset();
    expect(a.process(0.7, 1200, 0.5, 1)).toBeCloseTo(b.process(0.7, 1200, 0.5, 1), 12);
  });

  it('passes drive through to the SVF (drive changes the self-osc output)', () => {
    const a = new MorphFilter(SR); a.reset();
    const b = new MorphFilter(SR); b.reset();
    let diff = 0;
    for (let i = 0; i < 4000; i++) {
      const ya = a.process(0, 1000, 1.0, 0, 0); // morph 0 (low), drive 0
      const yb = b.process(0, 1000, 1.0, 0, 1); // morph 0 (low), drive 1
      diff += Math.abs(ya - yb);
    }
    expect(diff).toBeGreaterThan(0);
  });
});
