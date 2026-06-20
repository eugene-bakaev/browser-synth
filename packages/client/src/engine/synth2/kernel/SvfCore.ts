//
// Shared zero-delay-feedback state-variable filter core (spec §5.3, Andy
// Simper / Cytomic trapezoidal formulation). One state pair, three
// simultaneous outputs (low/band/high). Stable under per-sample cutoff
// modulation — the reason the engine abandons the biquad (§5.2). Pure DSP, no
// allocation after construction.
//
// Self-oscillation (spec 2026-06-20): resonance > 0.9 ramps the damping k below
// zero into a self-oscillating regime; a tanh feedback saturator on the band
// integrator state bounds the limit cycle, and a tiny noise floor — injected
// ONLY in that zone — seeds and sustains it from silence. resonance <= 0.9 with
// drive 0 is bit-identical to the original linear filter (Approach A).
//
// `drive` feeds the same saturator (pre-gain D), so it stays a bounded, gated
// limiter today, but its harmonic *character* is a deferred sound-design
// experiment: tanh(D*x)/D self-regulates the limit cycle back toward a clean
// sine, so raising drive does not yet add audible grit. Revisit (decided
// 2026-06-20).
//

const K09 = 1 / 9.05;        // k at resonance 0.9 (= 1/(0.5+0.9*9.5)) — ramp anchor
const K_MIN = -0.02;         // k at resonance 1.0 — slightly unstable ⇒ reliable osc
const SEED = 1e-4;           // oscillation-zone noise-floor amplitude (startup seed)
const DRIVE_RANGE = 4;       // drive 0..1 → saturator pre-gain D = 1..5
const RNG_SEED = 0x9e3779b9; // fixed xorshift32 seed ⇒ deterministic per note-on

export class SvfCore {
  /** Outputs, valid after the most recent tick(). */
  low = 0;
  band = 0;
  high = 0;

  private ic1eq = 0; // integrator 1 state (band)
  private ic2eq = 0; // integrator 2 state (low)
  private rng = RNG_SEED; // xorshift32 state for the oscillation-zone noise floor
  private readonly nyquistish: number;

  constructor(private readonly sampleRate: number) {
    // Keep tan(pi*fc/SR) finite: clamp cutoff below Nyquist.
    this.nyquistish = sampleRate * 0.45;
  }

  /** Note-on / voice-steal: clear integrator state, outputs, and re-seed the RNG. */
  reset(): void {
    this.ic1eq = 0;
    this.ic2eq = 0;
    this.rng = RNG_SEED;
    this.low = 0;
    this.band = 0;
    this.high = 0;
  }

  /** Advance one sample. cutoffHz is the final (post keytrack/env) cutoff;
   *  resonance 0..1 (>0.9 self-oscillates); drive 0..1 adds feedback saturation. */
  tick(input: number, cutoffHz: number, resonance: number, drive = 0): void {
    const inSafe = Number.isFinite(input) ? input : 0;
    const fc = cutoffHz < 20 ? 20 : cutoffHz > this.nyquistish ? this.nyquistish : cutoffHz;
    const g = Math.tan((Math.PI * fc) / this.sampleRate);

    // Resonance → damping k. res<=0.9 reproduces the original q=0.5+9.5r map
    // EXACTLY (Approach A); the top 10% ramps k from k(0.9) to a small negative
    // floor, continuous at the 0.9 join.
    const res = resonance < 0 ? 0 : resonance > 1 ? 1 : resonance;
    let k: number;
    let oscZone: number;
    if (res <= 0.9) {
      k = 1 / (0.5 + res * 9.5);
      oscZone = 0;
    } else {
      oscZone = (res - 0.9) / 0.1;          // 0..1 across the oscillation zone
      k = K09 + oscZone * (K_MIN - K09);    // continuous at 0.9; < 0 near the top
    }

    // Startup/sustain excitation: a tiny noise floor, ONLY in the oscillation
    // zone (so res<=0.9 is bit-unchanged). Seeds the oscillator from silence when
    // all oscillators are muted, and continuously re-excites it (analog thermal
    // noise). xorshift32 → bipolar ~[-1,1).
    let x = inSafe;
    if (oscZone > 0) {
      let s = this.rng;
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      this.rng = s >>> 0;
      x += SEED * oscZone * ((this.rng / 0x80000000) - 1);
    }

    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2eq;
    const v1 = a1 * this.ic1eq + a2 * v3;
    const v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;

    // Feedback saturator: soft-clip the band integrator state to bound the limit
    // cycle. Blend B = 0 (res<=0.9 AND drive==0) ⇒ fully bypassed ⇒ bit-linear.
    // tanh(D*x)/D keeps small-signal gain ≈ 1 so it never spontaneously boosts
    // resonance. drive raises the pre-gain D but its harmonic character is
    // deferred (see header note) — for now it only re-shapes/bounds the cycle.
    let blend = drive + oscZone;
    if (blend > 1) blend = 1;
    if (blend > 0) {
      const D = 1 + drive * DRIVE_RANGE;
      const sat = Math.tanh(D * this.ic1eq) / D;
      this.ic1eq += blend * (sat - this.ic1eq);
    }

    // I4 denormal sweep: V8 has no flush-to-zero; a silent input would otherwise
    // let the integrator state decay through the subnormal range (~100x slower).
    if (this.ic1eq < 1e-25 && this.ic1eq > -1e-25) this.ic1eq = 0;
    if (this.ic2eq < 1e-25 && this.ic2eq > -1e-25) this.ic2eq = 0;

    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;
  }
}
