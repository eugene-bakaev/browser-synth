// Per-voice LFO (spec §5.5): a bipolar −1..+1 morphed waveform that feeds the
// mod matrix as the lfo1/lfo2 sources. shape 0..4 linearly crossfades the
// adjacent waveforms sine → triangle → saw-up → saw-down → square. Naive
// (non-band-limited) by decision — band-limiting is a filed future follow-up.
// Pure, allocation-free (kernel ABI). next() must be called exactly once per
// rendered sample: it advances both ParamSlots' smoothers and the phase.

import type { ParamSlot } from './ParamSlot';

const TWO_PI = Math.PI * 2;

export class Lfo {
  private phase = 0; // [0, 1)

  constructor(
    private readonly rateSlot: ParamSlot,
    private readonly shapeSlot: ParamSlot,
    private readonly sampleRate: number,
  ) {}

  /** Note-on / voice-steal retrigger: restart the waveform. */
  reset(): void {
    this.phase = 0;
  }

  /** One bipolar −1..+1 sample. Computes at the current phase, then advances. */
  next(): number {
    const value = Lfo.wave(this.shapeSlot.next(), this.phase);
    const rate = this.rateSlot.next();
    this.phase += rate / this.sampleRate;
    if (this.phase >= 1) this.phase -= 1; // rate ≤ 2000 ≪ SR ⇒ at most one wrap
    return value;
  }

  /** Morphed shape s∈[0,4] at phase p∈[0,1): linear crossfade of two neighbours. */
  static wave(s: number, p: number): number {
    const c = s < 0 ? 0 : s > 4 ? 4 : s;
    const i = Math.min(3, Math.floor(c)); // 0..3; i+1 reaches 4 (square)
    const f = c - i;
    return Lfo.base(i, p) * (1 - f) + Lfo.base(i + 1, p) * f;
  }

  /** A single naive waveform at phase p∈[0,1), bipolar −1..+1. */
  private static base(shape: number, p: number): number {
    switch (shape) {
      case 0: return Math.sin(TWO_PI * p);                        // sine
      case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);  // triangle: shift peak to p=0.25, fold around 0.5, scale to [-1,1] (0 at p=0)
      case 2: return 2 * p - 1;                                   // saw-up
      case 3: return 1 - 2 * p;                                   // saw-down
      default: return p < 0.5 ? 1 : -1;                           // square (case 4)
    }
  }
}
