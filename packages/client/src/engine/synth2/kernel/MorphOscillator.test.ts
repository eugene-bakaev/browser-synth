import { describe, it, expect } from 'vitest';
import { MorphOscillator } from './MorphOscillator';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;
const TWO_PI = Math.PI * 2;

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

describe('MorphOscillator hard sync', () => {
  it('syncReset = -1 is bit-identical to the no-sync call (saw, morph 2)', () => {
    const n = 512;
    const freq = 220;
    const a = makeOsc(2);
    const b = makeOsc(2);
    for (let i = 0; i < n; i++) {
      expect(a.next(freq, 0, 0, -1)).toBeCloseTo(b.next(freq), 12);
    }
  });

  it('exposes wrapped/wrapFrac when the phase crosses a cycle', () => {
    const osc = makeOsc(2);
    let sawWrap = false;
    for (let i = 0; i < SR; i++) {
      osc.next(440);
      if (osc.wrapped) {
        sawWrap = true;
        expect(osc.wrapFrac).toBeGreaterThanOrEqual(0);
        expect(osc.wrapFrac).toBeLessThan(1);
      }
    }
    expect(sawWrap).toBe(true);
  });

  it('hard sync locks the slave period to the master', () => {
    // Master 220 Hz; slave detuned +7 semitones (free ≈ 330 Hz) and hard-synced.
    // The synced output must repeat at the MASTER rate (~220), not ~330.
    const SEMI = 7;
    const masterFreq = 220;
    const master = makeOsc(2);
    const slaveSynced = new MorphOscillator(
      slot('osc2.morph', 0, 3, 2), slot('osc2.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc2.coarse', -36, 36, SEMI), slot('osc2.fine', -100, 100, 0), SR,
    );
    const slaveFree = new MorphOscillator(
      slot('osc2.morph', 0, 3, 2), slot('osc2.pulseWidth', 0.05, 0.95, 0.5),
      slot('osc2.coarse', -36, 36, SEMI), slot('osc2.fine', -100, 100, 0), SR,
    );
    const synced = new Float32Array(SR);
    const free = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      master.next(masterFreq);
      synced[i] = slaveSynced.next(masterFreq, 0, 0, master.wrapped ? master.wrapFrac : -1);
      free[i] = slaveFree.next(masterFreq);
    }
    const freeHz = positiveZeroCrossings(free);
    const syncHz = positiveZeroCrossings(synced);
    expect(freeHz).toBeGreaterThan(310);   // ~330
    expect(syncHz).toBeLessThan(260);      // locked toward ~220
    expect(syncHz).toBeGreaterThan(190);
  });

  it('stays finite and bounded under sync while sweeping master pitch', () => {
    const master = makeOsc(2);
    const slave = makeOsc(2);
    for (let i = 0; i < 8192; i++) {
      const f = 110 + i / 8192 * 800;
      master.next(f);
      const s = slave.next(f * 1.5, 0, 0, master.wrapped ? master.wrapFrac : -1);
      expect(Number.isFinite(s)).toBe(true);
      expect(Math.abs(s)).toBeLessThan(2);
    }
  });
});

describe('MorphOscillator TZFM', () => {
  it('fmAmount 0 produces bit-identical output regardless of fmInput', () => {
    // osc.next(freq, fmInput, 0) must equal osc.next(freq) for every sample
    const n = 256;
    const freq = 220;
    // morph 2 (saw) makes the identity obvious without cancellation
    const oscFm = makeOsc(2);
    const oscRef = makeOsc(2);
    for (let i = 0; i < n; i++) {
      const modSample = Math.sin((TWO_PI * i * 330) / SR); // arbitrary non-zero FM input
      const fmVal = oscFm.next(freq, modSample, 0);
      const refVal = oscRef.next(freq);
      expect(fmVal).toBeCloseTo(refVal, 10);
    }
  });

  it('FM injects audible change when fmAmount > 0', () => {
    // A modulated carrier should diverge clearly from an unmodulated twin over 2048 samples.
    const n = 2048;
    const freq = 220;
    const oscFm = makeOsc(2);
    const oscRef = makeOsc(2);
    let totalAbsDiff = 0;
    for (let i = 0; i < n; i++) {
      const modSample = Math.sin((TWO_PI * i * 330) / SR);
      totalAbsDiff += Math.abs(oscFm.next(freq, modSample, 2) - oscRef.next(freq));
    }
    expect(totalAbsDiff).toBeGreaterThan(1);
  });

  it('stays finite (no NaN/Inf) under deep through-zero FM', () => {
    // fmAmount=4, modulator at full swing → dt goes deeply negative each half-cycle.
    const n = 4096;
    const freq = 220;
    const osc = makeOsc(2);
    for (let i = 0; i < n; i++) {
      const modSample = Math.sin((TWO_PI * i * 55) / SR); // slow modulator for wide swings
      const sample = osc.next(freq, modSample, 4);
      expect(Number.isFinite(sample)).toBe(true);
    }
  });

  it('triangle morph stays finite when FM halts the carrier (dt → 0)', () => {
    // morph=1 exercises the triangle normalization (1/dt term). TZFM makes
    // dt = dt0*(1 + amt*mod) hit exactly 0 when amt*mod = -1, which would send
    // norm → Infinity → NaN without the |dt| guard. Sweep the modulator across
    // -1 so it passes through the halt point.
    const osc = makeOsc(1);
    for (let i = 0; i < 4096; i++) {
      const modSample = Math.sin((TWO_PI * i * 55) / SR);
      const sample = osc.next(440, modSample, 4); // amt*mod reaches -4..+4, crossing -1
      expect(Number.isFinite(sample)).toBe(true);
    }
  });
});
