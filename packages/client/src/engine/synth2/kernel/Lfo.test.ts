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

const lfoWith = (rate: number, shape: number, mode = 0, seed = 1) =>
  new Lfo(
    new ParamSlot(desc(0.01, 2000, rate, 'expOctaves', 4), SR),
    new ParamSlot(desc(0, 4, shape, 'linear', 1), SR),
    new ParamSlot(desc(0, 2, mode, 'linear', 0), SR),
    SR,
    seed,
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

  // rate = SR/100 ⇒ phase steps 0.01/sample ⇒ a new cycle every 100 samples.
  const CYCLE = 100;
  const shRate = SR / CYCLE;

  it('S&H holds a constant value across each cycle and only steps at wraps', () => {
    const buf = collect(lfoWith(shRate, 0, 1, 42), 3 * CYCLE);
    const changes: number[] = [];
    for (let i = 1; i < buf.length; i++) if (buf[i] !== buf[i - 1]) changes.push(i);
    // Exactly one step per completed cycle, each ~CYCLE samples apart.
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.length).toBeLessThanOrEqual(3);
    for (const c of changes) expect(Math.abs((c % CYCLE)) <= 1 || Math.abs((c % CYCLE) - CYCLE) <= 1).toBe(true);
    for (const v of buf) { expect(v).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(-1); }
  });

  it('S&H is deterministic per seed and reproducible after reset', () => {
    const a = lfoWith(shRate, 0, 1, 42);
    const b = lfoWith(shRate, 0, 1, 42);
    expect([...collect(a, 400)]).toEqual([...collect(b, 400)]);
    const c = lfoWith(shRate, 0, 1, 7);
    expect([...collect(c, 400)]).not.toEqual([...collect(lfoWith(shRate, 0, 1, 42), 400)]);
    const r = lfoWith(shRate, 0, 1, 42);
    const first = [...collect(r, 400)];
    r.reset();
    expect([...collect(r, 400)]).toEqual(first);
  });

  it('Smooth starts flat, is continuous, and passes through the S&H targets', () => {
    const smooth = collect(lfoWith(shRate, 0, 2, 42), 3 * CYCLE);
    // First cycle (before the first wrap) is flat: prev == curr at construction.
    for (let i = 1; i < CYCLE - 1; i++) expect(smooth[i]).toBeCloseTo(smooth[0], 6);
    // No discontinuity: per-sample delta bounded by the ramp step (target span ≤ 2 over CYCLE).
    for (let i = 1; i < smooth.length; i++) expect(Math.abs(smooth[i] - smooth[i - 1])).toBeLessThan(0.05);
    // At the end of a cycle the smooth ramp has reached that cycle's S&H target.
    // One sample before the wrap the ramp is at phase 0.99, i.e. up to 1/CYCLE
    // (here 1%) short of the target for a max span of 2 — precision 1 (0.05)
    // covers that quantization headroom regardless of the seed's draw spacing.
    const sh = collect(lfoWith(shRate, 0, 1, 42), 3 * CYCLE);
    expect(smooth[2 * CYCLE - 2]).toBeCloseTo(sh[2 * CYCLE - 2], 1);
  });

  it('Off mode (0) is byte-identical to the static morph waveform', () => {
    const buf = collect(lfoWith(37, 2.3, 0, 99), 2000);
    // Re-derive phase the same way and compare to Lfo.wave.
    let phase = 0;
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBeCloseTo(Lfo.wave(2.3, phase), 6);
      phase += 37 / SR; if (phase >= 1) phase -= 1;
    }
  });
});
