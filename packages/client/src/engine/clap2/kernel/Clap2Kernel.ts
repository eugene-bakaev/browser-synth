//
// clap2 DSP kernel — pure TS, no AudioContext (unit-testable like Hat2Kernel).
// process(out, frames, blockStartFrame) renders the hand-clap into `out`.
//
// Synthesis (SOS "Synth Secrets" + the classic TR-909 clap): white noise gated by a
// short pulse train — `bursts` (2..5) transients spaced by `spread`, each a fast
// attack + exp(`body`) decay — summed with one longer exp(`room`) reverberant tail,
// the two balanced by `mix`, the whole source bandpass-filtered at `tone` (fixed Q,
// Chamberlin SVF). Monophonic: a retrigger restarts the voice (note pitch/duration
// ignored — a drum voices itself from params). Deterministic xorshift32 noise so
// tests are reproducible.

import { PARAM_COUNT, PARAM_INDEX, defaultParamBlock } from './params';

const MAX_EVENTS = 16;
const BANDPASS_Q = 0.7;   // broadened (was 1.2): a wider hand-cavity formant, not a whistle
const HF_INJECT = 0.5;    // highpass (bright) blend on the slap attacks
const BRIGHT_TC = 0.0012; // 1.2 ms bright-path decay — snap on the attack, gone by the body
const OUT_TRIM = 0.5;     // headroom: keeps overlapping transients + tail bounded
const BODY_LP_HZ = 2500;  // F8: gentle 1-pole LP on the BODY path only — tames the broad
                          // bandpass's white-noise HF skirt (centroid was ~7.7kHz) while the
                          // bright attack snap (HF-inject path) is left untouched.

const ATTACK = 0.00015;                       // 0.15 ms per-slap attack (was 0.5 ms; sharper)
const BASE_GAP = [1.0, 1.3, 1.7, 2.2];        // inter-slap gap multipliers (× spread), widening
const AMP_DECAY = 0.78;                        // each slap ~0.78× the previous
const JITTER_GAP = 0.18;                       // ±18% per-note gap jitter
const JITTER_AMP = 0.22;                       // ±22% per-note amplitude jitter

const I_TONE = PARAM_INDEX['tone'];
const I_SPREAD = PARAM_INDEX['spread'];
const I_BURSTS = PARAM_INDEX['bursts'];
const I_BODY = PARAM_INDEX['body'];
const I_ROOM = PARAM_INDEX['room'];
const I_MIX = PARAM_INDEX['mix'];
const I_LEVEL = PARAM_INDEX['level'];

interface HitEvent {
  frame: number;
  velocity: number;
}

export class Clap2Kernel {
  private readonly block = defaultParamBlock();
  private readonly events: HitEvent[];
  private head = 0;
  private count = 0;

  // Mono voice state (a retrigger restarts it).
  private active = false;
  private t = 0; // seconds since the current hit
  private velocity = 1;

  // Chamberlin state-variable filter state (bandpass of the noise source).
  private svfLow = 0;
  private svfBand = 0;

  // One-pole lowpass state on the body (bandpass) path — see BODY_LP_HZ.
  private bodyLp = 0;

  // Deterministic xorshift32 noise — free-runs across note-ons (never re-seeded on
  // trigger) so consecutive hits differ; seeded from the constructor so the worklet
  // can inject per-session entropy while tests/audit stay reproducible on the default.
  private rng: number;

  // Independent free-running PRNG for the per-note slap jitter, decorrelated from the
  // noise stream (different seed derivation). Free-runs across triggers like the noise.
  private scatterRng: number;

  // Per-trigger pattern, drawn in trigger(): absolute slap onset offsets (s) and
  // per-slap amplitudes. Fixed within a hit, re-drawn (jittered) every hit.
  private readonly slapOffset = new Float32Array(5);
  private readonly slapAmp = new Float32Array(5);
  private slapCount = 0;

  constructor(private readonly sampleRate: number, seed = 0x6d2b79f5) {
    this.rng = (seed >>> 0) || 0x6d2b79f5; // unsign; avoid the xorshift zero fixed-point
    this.scatterRng = ((seed >>> 0) ^ 0x9e3779b9) >>> 0 || 0x85ebca6b; // decorrelated from rng
    this.events = Array.from({ length: MAX_EVENTS }, () => ({ frame: 0, velocity: 1 }));
  }

  /** Full param block (base values, descriptor order). Non-finite entries ignored. */
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) {
      const v = block[i];
      if (Number.isFinite(v)) this.block[i] = v;
    }
  }

  /** time in seconds on the AudioContext clock. freq/duration ignored — a drum
   *  voices its own length from params. */
  noteOn(time: number, _freq: number, _duration: number, velocity: number): void {
    const vel = Number.isFinite(velocity) ? (velocity < 0 ? 0 : velocity > 1 ? 1 : velocity) : 1;
    const t = Number.isFinite(time) ? time : 0;
    if (this.count === MAX_EVENTS) {
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    const ev = this.events[(this.head + this.count) % MAX_EVENTS];
    ev.frame = Math.round(t * this.sampleRate);
    ev.velocity = vel;
    this.count++;
  }

  process(out: Float32Array, frames: number, blockStartFrame: number): void {
    out.fill(0);
    let cursor = 0;
    while (this.count > 0) {
      const ev = this.events[this.head];
      if (ev.frame >= blockStartFrame + frames) break; // due in a future block
      const offset = Math.max(0, ev.frame - blockStartFrame); // past-due → now
      this.render(out, cursor, offset);
      cursor = offset;
      this.trigger(ev.velocity);
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    this.render(out, cursor, frames);
  }

  private trigger(velocity: number): void {
    this.active = true;
    this.t = 0;
    this.velocity = velocity;
    this.svfLow = 0;
    this.svfBand = 0;
    this.bodyLp = 0;

    // Draw the non-uniform, amplitude-decaying, per-note-jittered slap pattern.
    const bursts = Math.max(2, Math.min(5, Math.round(this.block[I_BURSTS])));
    const spread = Math.max(1e-4, this.block[I_SPREAD]);
    this.slapCount = bursts;
    let off = 0;
    for (let j = 0; j < bursts; j++) {
      this.slapOffset[j] = off;
      const gap = BASE_GAP[Math.min(j, BASE_GAP.length - 1)] * (1 + JITTER_GAP * this.scatter());
      off += spread * Math.max(0.2, gap);
      const amp = Math.pow(AMP_DECAY, j) * (1 + JITTER_AMP * this.scatter());
      this.slapAmp[j] = Math.max(0.05, amp);
    }
  }

  /** xorshift32 → [-1, 1). */
  private noise(): number {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return (this.rng / 0xffffffff) * 2 - 1;
  }

  /** xorshift32 scatter draw → [-1, 1). Independent of the noise stream. */
  private scatter(): number {
    let x = this.scatterRng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.scatterRng = x >>> 0;
    return (this.scatterRng / 0xffffffff) * 2 - 1;
  }

  private render(out: Float32Array, from: number, to: number): void {
    if (to <= from || !this.active) return;
    const sr = this.sampleRate;
    const dt = 1 / sr;

    const tone = this.block[I_TONE];
    const body = Math.max(1e-3, this.block[I_BODY]);
    const room = Math.max(1e-3, this.block[I_ROOM]);
    const mix = Math.min(1, Math.max(0, this.block[I_MIX]));
    const level = this.block[I_LEVEL];

    // Chamberlin SVF coefficient. Clamp fc below ~sr/6 for stability.
    const fc = Math.min(tone, sr / 6);
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    const q = 1 / BANDPASS_Q;

    // Body-path 1-pole LP coefficient (F8). Corner clamped below the SVF clamp.
    const lpCoef = 1 - Math.exp((-2 * Math.PI * Math.min(BODY_LP_HZ, sr / 6)) / sr);

    // Mix → a burst/room crossfade. roomGain floors at 0 (was 0.2) so mix=0 is
    // pure slaps — no room bleed (fixes the audit's "tail never fully off").
    const burstGain = 1 - 0.5 * mix; // 1.0 … 0.5
    const roomGain = mix;            // 0.0 … 1.0

    const lastOnset = this.slapOffset[this.slapCount - 1];

    for (let i = from; i < to; i++) {
      const t = this.t;

      // Burst train: sum of per-slap AD envelopes at the drawn (non-uniform, jittered)
      // offsets and decaying amplitudes — the j-th slap starts at slapOffset[j].
      let burst = 0;
      let bright = 0;
      for (let j = 0; j < this.slapCount; j++) {
        const td = t - this.slapOffset[j];
        if (td >= 0) {
          const atk = td < ATTACK ? td / ATTACK : 1; // sharp attack, no onset click
          burst += this.slapAmp[j] * atk * Math.exp(-td / body);
          bright += this.slapAmp[j] * atk * Math.exp(-td / BRIGHT_TC); // fast bright env
        }
      }
      const roomEnv = Math.exp(-t / room);
      const env = burst * burstGain + roomEnv * roomGain;

      // Stop once the claps are over and the tail has decayed.
      if (t > lastOnset && env < 1e-4) {
        this.active = false;
        return; // remaining samples stay 0 (out was zero-filled)
      }

      // Two signal paths: bandpassed noise carries the body/room env; the SVF
      // highpass carries a fast bright "snap" on each slap attack.
      const input = this.noise();
      this.svfLow += f * this.svfBand;
      const high = input - this.svfLow - q * this.svfBand;
      this.svfBand += f * high;
      this.bodyLp += lpCoef * (this.svfBand - this.bodyLp); // tame the body HF skirt
      const bp = this.bodyLp;

      const sample = bp * env + high * bright * burstGain * HF_INJECT;
      out[i] += sample * this.velocity * level * OUT_TRIM;
      this.t += dt;
    }
  }
}
