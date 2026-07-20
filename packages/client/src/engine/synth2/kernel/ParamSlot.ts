//
// One cell per continuous parameter (spec §6.3): a smoothed base value
// (written from the param block — knob/sync) plus a per-sample modulation
// accumulator (written by the mod matrix; always 0 in I1 but implemented and
// tested now because every module is built against this contract).
//
// next() must be called EXACTLY once per rendered sample per slot — it
// advances the smoother. The owning module is responsible for that cadence.

import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SMOOTH_SECONDS = 0.005;

export class ParamSlot {
  /** Mod matrix input, bipolar. Cleared/written externally; 0 = unmodulated. */
  mod = 0;

  private target: number;
  private current: number;
  private readonly coeff: number;
  private readonly min: number;
  private readonly max: number;
  private readonly expTaper: boolean;
  private readonly modScale: number;
  private readonly range: number;

  constructor(desc: Synth2ParamDescriptor, sampleRate: number) {
    this.min = desc.min;
    this.max = desc.max;
    this.range = desc.max - desc.min;
    this.expTaper = desc.taper === 'expOctaves';
    this.modScale = desc.modScale;
    this.target = desc.default;
    this.current = desc.default;
    this.coeff = 1 - Math.exp(-1 / (SMOOTH_SECONDS * sampleRate));
  }

  setBase(v: number): void {
    // NaN-safe clamp (I4): ordered so a non-finite v lands on min, never leaks.
    this.target = v > this.max ? this.max : v >= this.min ? v : this.min;
  }

  /** Jump the smoother to its target. Cold-voice noteOn (F2, 2026-07-19): a
   *  freshly-activated voice must START at the session's values, not glide
   *  ~5ms from the compiled defaults — smoothing protects a RUNNING voice
   *  against clicks, it must not smear the first note's onset. */
  snap(): void {
    this.current = this.target;
  }

  next(): number {
    this.current += (this.target - this.current) * this.coeff;
    let v = this.current;
    if (this.mod !== 0) {
      v = this.expTaper
        ? v * Math.pow(2, this.mod * this.modScale)
        : v + this.mod * this.modScale * this.range;
    }
    // NaN-safe clamp (I4): a non-finite v (e.g. NaN mod) falls through to min.
    return v > this.max ? this.max : v >= this.min ? v : this.min;
  }
}
