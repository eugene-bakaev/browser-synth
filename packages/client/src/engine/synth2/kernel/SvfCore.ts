//
// Shared zero-delay-feedback state-variable filter core (spec §5.3, Andy
// Simper / Cytomic trapezoidal formulation). One state pair, three
// simultaneous outputs (low/band/high). Stable under per-sample cutoff
// modulation — the reason the engine abandons the biquad (§5.2). Pure DSP, no
// allocation after construction.
//
// Self-oscillation (spec 2026-06-20, redesigned): resonance > 0.9 ramps the
// damping k toward a small negative value so the filter wants to oscillate at the
// cutoff. Rather than letting the bare limit cycle set its own (cutoff-dependent,
// bass-starved, slow-building) amplitude, the oscillation zone is actively
// regulated — see tick():
//   • a one-shot KICK seeds the low state to the target the instant the voice
//     enters the zone, so onset is immediate at any cutoff (no slow high-Q
//     ring-up that left the bass near-silent);
//   • an amplitude AGC rescales the whole state vector toward a fixed target each
//     sample, so the sung level is the SAME from 55 Hz to 2.5 kHz (uniform
//     scaling preserves the trajectory ⇒ clean sine, pitch unchanged);
//   • `drive` is a real drive: it pushes the OUTPUT through tanh(D·x) (no feedback
//     into the core, so the oscillator stays stable), getting louder and grittier
//     — squarer, more harmonics — as it rises. drive 0 ≈ clean sine.
//
// F1 (2026-07-19): the same output-only tanh(D·x) saturator also applies on
// the normal (non-oscillating) path, gated on `drive > 0` — it was previously
// read but never used below resonance 0.9 (~90% of the range), a dead knob.
// resonance <= 0.9 WITH drive 0 stays bit-identical to the original linear
// filter (Approach A): the saturator is gated on drive > 0 on both paths.
//

const K09 = 1 / 9.05;        // k at resonance 0.9 (= 1/(0.5+0.9*9.5)) — ramp anchor
const K_MIN = -0.012;        // k at resonance 1.0. The ramp is CUBIC (k = K_MIN +
                             // (K09-K_MIN)*(1-z)^3), so damping collapses to ~0 over the
                             // upper half of the zone ⇒ a wide, high-Q, in-tune singing
                             // range rather than a sliver at the very top.
const SEED = 1e-4;           // oscillation-zone noise-floor amplitude (liveliness)
const OSC_TARGET = 0.3;      // regulated self-oscillation peak (cutoff-independent)
const TWO_OVER_PI = 0.63662; // mean(|sine|)/peak — maps the mean estimator to a peak target
const REL_CYCLES = 4;        // AGC amplitude-estimator time constant, in oscillation
                             // CYCLES — derived from cutoff so behaviour is pitch-independent
const GAIN_PER_CYCLE = 0.25; // max AGC gain change per CYCLE (also cutoff-derived) — keeps
                             // the gain slow enough to never waveshape, yet able to sustain
const DRIVE_PRE = 4;         // drive 0..1 → output saturator pre-gain D = 1..5
const RNG_SEED = 0x9e3779b9; // fixed xorshift32 seed ⇒ deterministic per note-on

export class SvfCore {
  /** Outputs, valid after the most recent tick(). */
  low = 0;
  band = 0;
  high = 0;

  private ic1eq = 0; // integrator 1 state (band)
  private ic2eq = 0; // integrator 2 state (low)
  private oscEnv = 0; // AGC peak-follower of the low state (oscillation zone)
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
    this.oscEnv = 0;
    this.rng = RNG_SEED;
    this.low = 0;
    this.band = 0;
    this.high = 0;
  }

  /** Advance one sample. cutoffHz is the final (post keytrack/env) cutoff;
   *  resonance 0..1 (>0.9 self-oscillates); drive 0..1 overdrives the output. */
  tick(input: number, cutoffHz: number, resonance: number, drive = 0): void {
    const inSafe = Number.isFinite(input) ? input : 0;
    const fc = cutoffHz < 20 ? 20 : cutoffHz > this.nyquistish ? this.nyquistish : cutoffHz;
    const g = Math.tan((Math.PI * fc) / this.sampleRate);

    // Resonance → damping k. res<=0.9 reproduces the original q=0.5+9.5r map
    // EXACTLY (Approach A); the top 10% ramps k from k(0.9) down to a small
    // negative floor along a cubic curve — continuous at the 0.9 join, but
    // collapsing to ~0 fast so most of the zone is high-Q and sings.
    const res = resonance < 0 ? 0 : resonance > 1 ? 1 : resonance;
    let k: number;
    let oscZone: number;
    if (res <= 0.9) {
      k = 1 / (0.5 + res * 9.5);
      oscZone = 0;
    } else {
      oscZone = (res - 0.9) / 0.1;          // 0..1 across the oscillation zone
      const t = 1 - oscZone;
      k = K_MIN + (K09 - K_MIN) * t * t * t; // continuous at 0.9; collapses to ~0 fast
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

    // Default (linear) outputs — res<=0.9 path is byte-for-byte the original
    // filter; the oscillation-zone block below overwrites them when active.
    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;

    // F1 (2026-07-19): drive now works on the normal path too — same
    // output-only saturator as the oscillation zone (never fed back into the
    // integrators; state and stability untouched). Gated on drive > 0 so
    // drive-at-0 keeps the bit-identical compat invariant above.
    if (drive > 0 && oscZone <= 0) {
      const D = 1 + drive * DRIVE_PRE;
      this.low = Math.tanh(D * this.low);
      this.band = Math.tanh(D * this.band);
      this.high = Math.tanh(D * this.high);
    }

    if (oscZone > 0) {
      const target = OSC_TARGET * oscZone;

      const targetEnv = TWO_OVER_PI * target; // mean(|low|) that yields `target` peak

      // Instant onset: the moment the voice enters the zone from rest, kick the
      // low state straight to the target. Skips the slow, cutoff-dependent
      // high-Q ring-up that otherwise left the bass near-silent for seconds.
      if (this.ic1eq * this.ic1eq + this.ic2eq * this.ic2eq < 1e-12) {
        this.ic2eq = target;
        this.oscEnv = targetEnv;
      }

      // Amplitude AGC. A SMOOTH mean estimate of the low-state amplitude drives a
      // gain that rescales the WHOLE state vector toward `target`. Two properties
      // make it clean AND stable at every pitch:
      //   • the estimator time constant and the per-sample gain limit are both
      //     derived from the cutoff (fixed cycle counts), so the loop dynamics are
      //     identical at 55 Hz and 2.5 kHz — no within-cycle waveshaping, no
      //     low-frequency overshoot;
      //   • uniform scaling preserves the trajectory (clean sine) and the pitch.
      // It tops up the energy the (now very light) damping bleeds off, so the whole
      // upper resonance range sustains at the same level instead of just res≈1.
      const mag = this.ic2eq < 0 ? -this.ic2eq : this.ic2eq;
      let rel = fc / (REL_CYCLES * this.sampleRate);
      if (rel > 0.5) rel = 0.5;
      this.oscEnv += (mag - this.oscEnv) * rel;
      if (this.oscEnv > 1e-6) {
        let norm = targetEnv / this.oscEnv;
        let gl = (GAIN_PER_CYCLE * fc) / this.sampleRate; // max gain deviation / sample
        if (gl > 0.5) gl = 0.5;
        if (norm > 1 + gl) norm = 1 + gl;
        else if (norm < 1 - gl) norm = 1 - gl;
        this.ic1eq *= norm;
        this.ic2eq *= norm;
      }

      // Drive: overdrive the OUTPUT through tanh(D·x). Applied to the outputs
      // only — never fed back into the integrators — so the oscillator core stays
      // stable while the sound gets louder and grittier (squarer, more harmonics)
      // as drive rises. drive 0 ⇒ D=1 ⇒ tanh(x) ≈ x ⇒ ~clean sine.
      const D = 1 + drive * DRIVE_PRE;
      this.low = Math.tanh(D * this.ic2eq);
      this.band = Math.tanh(D * this.ic1eq);
      this.high = Math.tanh(D * (x - k * this.ic1eq - this.ic2eq));
    }

    // I4 denormal sweep: V8 has no flush-to-zero; a silent input would otherwise
    // let the integrator state decay through the subnormal range (~100x slower).
    if (this.ic1eq < 1e-25 && this.ic1eq > -1e-25) this.ic1eq = 0;
    if (this.ic2eq < 1e-25 && this.ic2eq > -1e-25) this.ic2eq = 0;
  }
}
