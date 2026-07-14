// Per-voice LFO (spec §5.5 + random modes 2026-07-13): a bipolar −1..+1 signal
// feeding the mod matrix as the lfo1/lfo2 sources.
//
//   mode 0 Off    — a morphed waveform. shape 0..4 linearly crossfades the
//                   adjacent waveforms sine → triangle → saw-up → saw-down →
//                   square. Naive (non-band-limited) by decision — band-limiting
//                   is a filed future follow-up.
//   mode 1 S&H    — each cycle (phase wrap) draw a fresh random value in [−1,+1)
//                   and hold it flat until the next wrap. shape is ignored.
//   mode 2 Smooth — the same per-cycle random targets, but the output ramps
//                   linearly from the previous target to the new one across the
//                   cycle (one segment per cycle, no discontinuity). shape ignored.
//
// Randomness is a per-instance xorshift32 (the Noise.ts generator), seeded ONCE
// at construction and then FREE-RUNNING: reset() (note-on) does NOT rewind it, so
// S&H/Smooth draw fresh values on every note instead of replaying one fixed
// sequence. The per-voice construction seed keeps voices decorrelated; the kernel
// mixes in per-load entropy so patterns also differ across sessions.
// Pure, allocation-free (kernel ABI §6.7). next() must be called exactly once per
// rendered sample: it advances all three ParamSlots' smoothers and the phase.

import type { ParamSlot } from './ParamSlot';

const TWO_PI = Math.PI * 2;

export class Lfo {
  private phase = 0;   // [0, 1)
  private rngState: number;
  private prev = 0;    // previous random target (Smooth ramp start)
  private curr = 0;    // current random target (S&H hold value / Smooth ramp end)

  constructor(
    private readonly rateSlot: ParamSlot,
    private readonly shapeSlot: ParamSlot,
    private readonly modeSlot: ParamSlot,
    private readonly sampleRate: number,
    seed = 1,
  ) {
    this.rngState = (seed | 0) || 0x9e3779b9; // avoid the xorshift zero fixed-point
    this.curr = this.draw();
    this.prev = this.curr;
  }

  /** Note-on / voice-steal retrigger: restart the waveform (phase 0) and draw a
   *  fresh S&H/Smooth target. The RNG is deliberately NOT re-seeded — it free-runs
   *  across notes, so each note-on continues the random stream (every note differs)
   *  rather than replaying one fixed sequence. prev = curr so Smooth starts flat. */
  reset(): void {
    this.phase = 0;
    this.curr = this.draw();
    this.prev = this.curr;
  }

  /** One bipolar −1..+1 sample. Advances all slot smoothers and the phase. */
  next(): number {
    const shape = this.shapeSlot.next();          // read every sample (ABI: advance smoother)
    const mode = Math.round(this.modeSlot.next()); // 0/1/2; snap, not smoothed (an enum)
    const rate = this.rateSlot.next();

    if (mode <= 0) {
      // Off: value at the current phase, then advance (unchanged behavior).
      const value = Lfo.wave(shape, this.phase);
      this.advance(rate);
      return value;
    }

    // S&H / Smooth: advance first; redraw on wrap; then read the held / ramped value.
    const wrapped = this.advance(rate);
    if (wrapped) { this.prev = this.curr; this.curr = this.draw(); }
    return mode === 1 ? this.curr : this.prev + (this.curr - this.prev) * this.phase;
  }

  /** Advance the phase by one sample at `rate`; returns true if it wrapped. */
  private advance(rate: number): boolean {
    this.phase += rate / this.sampleRate;
    if (this.phase >= 1) { this.phase -= 1; return true; } // rate ≤ 2000 ≪ SR ⇒ ≤ one wrap
    return false;
  }

  /** One xorshift32 draw mapped to [−1, +1). */
  private draw(): number {
    let x = this.rngState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState / 0xffffffff) * 2 - 1;
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
