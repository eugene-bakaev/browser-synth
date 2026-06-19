//
// Shared zero-delay-feedback state-variable filter core (spec §5.3, Andy
// Simper / Cytomic trapezoidal formulation). One state pair, three
// simultaneous outputs (low/band/high). Stable under per-sample cutoff
// modulation — the reason the engine abandons the biquad (§5.2). Pure DSP, no
// allocation after construction. Coefficients (g, k) are recomputed every
// sample from the caller's cutoff/resonance; the per-sample `tan` is accepted
// for v1 (coefficient caching is I4 polish).
//

export class SvfCore {
  /** Outputs, valid after the most recent tick(). */
  low = 0;
  band = 0;
  high = 0;

  private ic1eq = 0; // integrator 1 state
  private ic2eq = 0; // integrator 2 state
  private readonly nyquistish: number;

  constructor(private readonly sampleRate: number) {
    // Keep tan(pi*fc/SR) finite: clamp cutoff below Nyquist.
    this.nyquistish = sampleRate * 0.45;
  }

  /** Note-on / voice-steal: clear integrator state and outputs. */
  reset(): void {
    this.ic1eq = 0;
    this.ic2eq = 0;
    this.low = 0;
    this.band = 0;
    this.high = 0;
  }

  /** Advance one sample. cutoffHz is the final (post keytrack/env) cutoff;
   *  resonance 0..1 maps to Q 0.5..10. */
  tick(input: number, cutoffHz: number, resonance: number): void {
    const fc = cutoffHz < 20 ? 20 : cutoffHz > this.nyquistish ? this.nyquistish : cutoffHz;
    const g = Math.tan((Math.PI * fc) / this.sampleRate);
    const q = 0.5 + resonance * 9.5;
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = input - this.ic2eq;
    const v1 = a1 * this.ic1eq + a2 * v3;
    const v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;
    // I4 denormal sweep: V8 has no flush-to-zero, so a silent input lets the
    // integrator state decay through the subnormal range (~100x slower on some
    // CPUs). 1e-25 is far above the subnormal boundary (~2.2e-308) yet
    // inaudible. Inline comparisons (no Math.abs call) keep the hot loop lean.
    if (this.ic1eq < 1e-25 && this.ic1eq > -1e-25) this.ic1eq = 0;
    if (this.ic2eq < 1e-25 && this.ic2eq > -1e-25) this.ic2eq = 0;
    this.low = v2;
    this.band = v1;
    this.high = input - k * v1 - v2;
  }
}
