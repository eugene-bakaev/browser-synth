import { describe, it, expect } from 'vitest';
import { Lfo } from './Lfo';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;

// Build a ParamSlot whose default IS the value we want (constructor sets
// current=target=default, so next() returns it with no smoother ramp).
const desc = (
  min: number, max: number, def: number,
  taper: 'linear' | 'expOctaves', modScale: number,
): Synth2ParamDescriptor => ({ key: 'lfo.test', min, max, default: def, taper, modulatable: true, modScale });

const lfoWith = (rate: number, shape: number) =>
  new Lfo(
    new ParamSlot(desc(0.01, 2000, rate, 'expOctaves', 4), SR),
    new ParamSlot(desc(0, 4, shape, 'linear', 1), SR),
    SR,
  );

const collect = (lfo: Lfo, n: number) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lfo.next();
  return out;
};

describe('Lfo', () => {
  it('first sample after construction is the phase-0 waveform value', () => {
    expect(lfoWith(5, 0).next()).toBeCloseTo(0, 6);   // sine(0) = 0
    expect(lfoWith(5, 2).next()).toBeCloseTo(-1, 6);  // saw-up at phase 0 = -1
    expect(lfoWith(5, 3).next()).toBeCloseTo(1, 6);   // saw-down at phase 0 = +1 (peak)
    expect(lfoWith(5, 4).next()).toBeCloseTo(1, 6);   // square first half = +1
  });

  it('completes one cycle per (sampleRate / rate) samples', () => {
    // 100 Hz sine: count positive-going zero crossings over 1 second ≈ 100.
    const lfo = lfoWith(100, 0);
    const buf = collect(lfo, SR);
    let crossings = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i - 1] < 0 && buf[i] >= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(99);
    expect(crossings).toBeLessThanOrEqual(101);
  });

  it('every shape stays bipolar within [-1, 1]', () => {
    for (const shape of [0, 1, 2, 3, 4, 0.5, 2.5, 3.7]) {
      const buf = collect(lfoWith(37, shape), 4000);
      for (const v of buf) { expect(v).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(-1); }
    }
  });

  it('square (shape 4) emits only ±1', () => {
    for (const v of collect(lfoWith(50, 4), 2000)) expect(Math.abs(v)).toBeCloseTo(1, 6);
  });

  it('shape 0.5 is the linear crossfade of sine and triangle', () => {
    // Same rate + both reset to phase 0 ⇒ phases stay in lockstep.
    const sine = lfoWith(7, 0), tri = lfoWith(7, 1), mid = lfoWith(7, 0.5);
    for (let i = 0; i < 3000; i++) {
      const s = sine.next(), t = tri.next(), m = mid.next();
      expect(m).toBeCloseTo(0.5 * s + 0.5 * t, 5);
    }
  });

  it('morph at a non-0.5 fraction blends the neighbours by weight (and 2.5 cancels to ~0)', () => {
    // shape 0.75 ⇒ 0.25·sine + 0.75·triangle, in phase lockstep.
    const sine = lfoWith(7, 0), tri = lfoWith(7, 1), q = lfoWith(7, 0.75);
    for (let i = 0; i < 2000; i++) {
      const s = sine.next(), t = tri.next(), m = q.next();
      expect(m).toBeCloseTo(0.25 * s + 0.75 * t, 5);
    }
    // shape 2.5 ⇒ 0.5·saw-up + 0.5·saw-down = ((2p-1) + (1-2p))/2 = 0 for all phase.
    for (const v of collect(lfoWith(40, 2.5), 2000)) expect(v).toBeCloseTo(0, 6);
  });

  it('reset() returns the phase to 0', () => {
    const lfo = lfoWith(123, 0);
    collect(lfo, 137);            // advance to some mid-cycle phase
    lfo.reset();
    expect(lfo.next()).toBeCloseTo(0, 6); // sine(0) again
  });
});
