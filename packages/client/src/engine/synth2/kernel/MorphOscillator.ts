// Continuous-morph oscillator on ONE phase accumulator (spec §5.2/§6.8):
// morph 0 sine → 1 triangle → 2 saw → 3 pulse, equal-power crossfade between
// the two adjacent shapes. Saw and pulse edges are PolyBLEP-corrected.
// Triangle is the classic leaky integration of the BLEP square — proven,
// cheap, and phase-locked to the shared accumulator (slight HF rolloff vs a
// true BLAMP triangle is accepted for I1).
//
// The 50%-duty square feeding the integrator is computed EVERY sample, even
// when triangle isn't audible, so morphing into triangle never starts from a
// stale integrator state.

import { polyBLEP } from './blep';
import type { ParamSlot } from './ParamSlot';

const TWO_PI = Math.PI * 2;
const TRI_LEAK = 0.995;
const HALF_PI = Math.PI / 2;

export class MorphOscillator {
  private phase = 0;
  private tri = 0;

  constructor(
    private readonly morph: ParamSlot,
    private readonly pulseWidth: ParamSlot,
    private readonly coarse: ParamSlot,
    private readonly fine: ParamSlot,
    private readonly sampleRate: number,
  ) {}

  /** Note-on phase reset (only called when the voice was idle — D3 handles steals). */
  reset(): void {
    this.phase = 0;
    this.tri = 0;
  }

  next(baseFreq: number, fmInput = 0, fmAmount = 0): number {
    const semis = this.coarse.next() + this.fine.next() / 100;
    const f = baseFreq * Math.pow(2, semis / 12);
    const dt0 = f / this.sampleRate;
    const dt = dt0 * (1 + fmAmount * fmInput); // through-zero FM; dt may go negative
    const pw = this.pulseWidth.next();
    const m = this.morph.next();

    // Keep the triangle integrator alive on the 50% square.
    let sq50 = this.phase < 0.5 ? 1 : -1;
    sq50 += polyBLEP(this.phase, dt);
    let tFall50 = this.phase - 0.5;
    // Wrap positions the falling-edge discontinuity at the BLEP window origin.
    if (tFall50 < 0) tFall50 += 1;
    sq50 -= polyBLEP(tFall50, dt);
    this.tri = TRI_LEAK * this.tri + 4 * dt * sq50;

    const seg = m >= 3 ? 2 : Math.floor(m);
    const frac = m - seg;
    let out = Math.cos(frac * HALF_PI) * this.shape(seg, dt, pw);
    if (frac > 0) out += Math.sin(frac * HALF_PI) * this.shape(seg + 1, dt, pw);

    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    else if (this.phase < 0) this.phase += 1;
    return out;
  }

  private shape(index: number, dt: number, pw: number): number {
    switch (index) {
      case 0:
        return Math.sin(TWO_PI * this.phase);
      case 1: {
        // Normalizes the integrator's transient-corrected peak so output stays
        // bounded: the startup transient otherwise breaches ±1.5 at high
        // frequencies (the formula computes the peak the integrator reaches
        // during that transient and divides it out). The steady-state triangle
        // still sits below unity and rolls off with frequency — the known
        // leaky-triangle tradeoff accepted for I1.
        // TODO(I4): cache norm (changes only with dt) and revisit triangle loudness-matching under profiling.
        // TZFM can drive dt to/through zero (carrier momentarily halted when
        // fmAmount*fmInput = -1). The 1/dt term in norm would then be Infinity →
        // NaN output, so normalize on |dt| and short-circuit a (near-)halted
        // carrier to 0. At positive dt (I1 / no-FM) this is bit-identical.
        const adt = dt < 0 ? -dt : dt;
        if (adt < 1e-7) return 0;
        const norm = (1 - TRI_LEAK) / (4 * adt * (1 - Math.pow(TRI_LEAK, 0.5 / adt)));
        return this.tri * norm;
      }
      case 2: {
        let s = 2 * this.phase - 1;
        s -= polyBLEP(this.phase, dt);
        return s;
      }
      default: {
        let p = this.phase < pw ? 1 : -1;
        p += polyBLEP(this.phase, dt);
        let tFall = this.phase - pw;
        // Wrap positions the falling-edge discontinuity at the BLEP window origin.
        if (tFall < 0) tFall += 1;
        p -= polyBLEP(tFall, dt);
        return p;
      }
    }
  }
}
