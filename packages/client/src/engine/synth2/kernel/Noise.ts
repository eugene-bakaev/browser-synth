// Per-voice white-noise source with a one-pole "color" lowpass (spec §6.8).
// Seeded xorshift32 → deterministic under test. color: 1 = white (no filtering),
// →0 = progressively darker. Pure, allocation-free (kernel ABI §6.7).

export class Noise {
  private state: number;
  private lp = 0; // one-pole lowpass memory

  constructor(seed: number) {
    // Avoid the zero fixed-point of xorshift; keep it a 32-bit uint.
    this.state = (seed | 0) || 0x9e3779b9;
  }

  /** @param color 0..1 lowpass openness (1 = white). Returns one sample in [-1, 1). */
  next(color: number): number {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    const white = (this.state / 0xffffffff) * 2 - 1; // [-1, 1)
    const c = color < 0 ? 0 : color > 1 ? 1 : color;
    // c=1 → pass-through (white); c→0 → heavier lowpass.
    this.lp = this.lp + c * (white - this.lp);
    return c >= 1 ? white : this.lp;
  }
}
