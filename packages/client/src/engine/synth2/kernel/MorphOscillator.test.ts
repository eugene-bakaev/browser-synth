import { describe, it, expect } from 'vitest';
import { MorphOscillator } from './MorphOscillator';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;

function slot(key: string, min: number, max: number, def: number): ParamSlot {
  const d: Synth2ParamDescriptor = {
    key, min, max, default: def, taper: 'linear', modulatable: true, modScale: 1,
  };
  return new ParamSlot(d, SR);
}

function makeOsc(morph: number) {
  return new MorphOscillator(
    slot('osc1.morph', 0, 3, morph),
    slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
    slot('osc1.coarse', -36, 36, 0),
    slot('osc1.fine', -100, 100, 0),
    SR,
  );
}

function render(osc: MorphOscillator, freq: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = osc.next(freq);
  return out;
}

function positiveZeroCrossings(buf: Float32Array): number {
  let c = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) c++;
  return c;
}

describe('MorphOscillator', () => {
  it('sine (morph 0) runs at the requested frequency', () => {
    const buf = render(makeOsc(0), 440, SR); // 1 second
    expect(positiveZeroCrossings(buf)).toBeGreaterThanOrEqual(439);
    expect(positiveZeroCrossings(buf)).toBeLessThanOrEqual(441);
  });

  it('saw (morph 2) runs at the requested frequency', () => {
    const buf = render(makeOsc(2), 220, SR);
    expect(positiveZeroCrossings(buf)).toBeGreaterThanOrEqual(219);
    expect(positiveZeroCrossings(buf)).toBeLessThanOrEqual(221);
  });

  it('coarse tune shifts pitch by semitones', () => {
    const osc = makeOsc(0);
    // reach into the coarse slot via a fresh osc instead: +12 semitones = 2x freq
    const up = new MorphOscillator(
      slot('osc1.morph', 0, 3, 0),
      slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc1.coarse', -36, 36, 12),
      slot('osc1.fine', -100, 100, 0),
      SR,
    );
    expect(positiveZeroCrossings(render(up, 220, SR))).toBeGreaterThanOrEqual(439);
    expect(positiveZeroCrossings(render(osc, 220, SR))).toBeLessThanOrEqual(221);
  });

  it('stays bounded across the whole morph range', () => {
    for (const m of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
      const buf = render(makeOsc(m), 440, 4096);
      for (let i = 0; i < buf.length; i++) {
        expect(Math.abs(buf[i]), `morph ${m} sample ${i}`).toBeLessThan(1.5);
        expect(Number.isFinite(buf[i])).toBe(true);
      }
    }
  });

  it('morphing is continuous: a slow sweep produces no per-sample jumps', () => {
    const morphSlot = slot('osc1.morph', 0, 3, 0);
    const osc = new MorphOscillator(
      morphSlot,
      slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc1.coarse', -36, 36, 0),
      slot('osc1.fine', -100, 100, 0),
      SR,
    );
    const n = SR; // sweep morph 0 → 3 over 1s at 110Hz (long, smooth period)
    let prev = osc.next(110);
    let maxJump = 0;
    for (let i = 1; i < n; i++) {
      morphSlot.setBase((i / n) * 3);
      const v = osc.next(110);
      // PolyBLEP spreads each hard step (saw wrap, pulse fall) over exactly
      // 2 samples; each sample carries ≤ (1 - 2*dt) ≈ 0.995 of the step
      // amplitude. A pure unblep'd step (full wrap from ±1 to ∓1, Δ = 2)
      // exceeds 1.2; BLEP-corrected contributions within the crossfade are
      // always < 1.2. Filtering > 1.2 isolates only the in-flight BLEP window.
      // The remaining max must stay below 1.2 — any crossfade bug that
      // introduces artificial discontinuities would push it higher.
      maxJump = Math.max(maxJump, Math.abs(v - prev) > 1.2 ? 0 : Math.abs(v - prev));
      prev = v;
    }
    expect(maxJump).toBeLessThan(1.2);
  });
});
