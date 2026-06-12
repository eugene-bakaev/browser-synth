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
    // +12-semitone osc expects ~440Hz at base 220 (2x); untuned baseline expects ~220.
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

  it('crossfade adds no discontinuity over the continuous region (morph 0→1)', () => {
    const morphSlot = slot('osc1.morph', 0, 3, 0);
    const osc = new MorphOscillator(
      morphSlot,
      slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc1.coarse', -36, 36, 0),
      slot('osc1.fine', -100, 100, 0),
      SR,
    );
    const n = SR; // sweep morph 0 → 1 at 110Hz; sine and triangle are both continuous,
                  // so NO band-limited edges exist — every jump is the crossfade + slope.
    let prev = osc.next(110);
    let maxJump = 0;
    for (let i = 1; i < n; i++) {
      morphSlot.setBase(i / n);           // 0 → 1
      const v = osc.next(110);
      maxJump = Math.max(maxJump, Math.abs(v - prev));
      prev = v;
    }
    // 110Hz sine's natural per-sample slope is ~2π·dt ≈ 0.014; measured worst jump ≈ 0.018.
    // 0.1 gives ~5x headroom yet a hard-switch / discontinuous crossfade (~0.7+) fails.
    expect(maxJump).toBeLessThan(0.1);
  });

  it('fine tune shifts pitch by cents', () => {
    // +100 cents = +1 semitone; at base 440Hz expect ~466.16Hz (440 * 2^(1/12)).
    const osc = new MorphOscillator(
      slot('osc1.morph', 0, 3, 0),
      slot('osc1.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc1.coarse', -36, 36, 0),
      slot('osc1.fine', -100, 100, 100),
      SR,
    );
    const buf = render(osc, 440, SR); // 1 second
    const crossings = positiveZeroCrossings(buf);
    expect(crossings).toBeGreaterThanOrEqual(465);
    expect(crossings).toBeLessThanOrEqual(468);
  });

  it('pulse width changes duty cycle', () => {
    // morph 3 = pure pulse; pw=0.5 → ~50% of samples positive; pw=0.2 → ~20%.
    function makeOscWithPw(pw: number) {
      return new MorphOscillator(
        slot('osc1.morph', 0, 3, 3),
        slot('osc1.pulseWidth', 0.05, 0.95, pw),
        slot('osc1.coarse', -36, 36, 0),
        slot('osc1.fine', -100, 100, 0),
        SR,
      );
    }
    const freq = 440;
    const warmup = Math.floor(SR / 4); // render and discard to let smoothing settle
    const measure = 4096;

    const osc50 = makeOscWithPw(0.5);
    render(osc50, freq, warmup);
    const buf50 = render(osc50, freq, measure);

    const osc20 = makeOscWithPw(0.2);
    render(osc20, freq, warmup);
    const buf20 = render(osc20, freq, measure);

    function positiveFraction(buf: Float32Array): number {
      let count = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] > 0) count++;
      return count / buf.length;
    }

    const frac50 = positiveFraction(buf50);
    const frac20 = positiveFraction(buf20);
    expect(frac50).toBeGreaterThanOrEqual(0.45);
    expect(frac50).toBeLessThanOrEqual(0.55);
    expect(frac20).toBeGreaterThanOrEqual(0.15);
    expect(frac20).toBeLessThanOrEqual(0.25);
  });
});
