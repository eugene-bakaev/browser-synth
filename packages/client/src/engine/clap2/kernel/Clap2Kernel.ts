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
const BANDPASS_Q = 1.2;   // analog ClapEngine value; fixed (not a knob)
const OUT_TRIM = 0.5;     // headroom: keeps overlapping transients + tail bounded

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

  // Deterministic xorshift32 noise — free-runs across note-ons (never re-seeded on
  // trigger) so consecutive hits differ; seeded from the constructor so the worklet
  // can inject per-session entropy while tests/audit stay reproducible on the default.
  private rng: number;

  constructor(private readonly sampleRate: number, seed = 0x6d2b79f5) {
    this.rng = (seed >>> 0) || 0x6d2b79f5; // unsign; avoid the xorshift zero fixed-point
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

  private render(out: Float32Array, from: number, to: number): void {
    if (to <= from || !this.active) return;
    const sr = this.sampleRate;
    const dt = 1 / sr;

    const tone = this.block[I_TONE];
    const spread = Math.max(1e-4, this.block[I_SPREAD]);
    const bursts = Math.max(2, Math.min(5, Math.round(this.block[I_BURSTS])));
    const body = Math.max(1e-3, this.block[I_BODY]);
    const room = Math.max(1e-3, this.block[I_ROOM]);
    const mix = Math.min(1, Math.max(0, this.block[I_MIX]));
    const level = this.block[I_LEVEL];

    // Chamberlin SVF coefficient. Clamp fc below ~sr/6 for stability.
    const fc = Math.min(tone, sr / 6);
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    const q = 1 / BANDPASS_Q;

    // Mix → independent gains so neither the claps nor the room tail ever vanishes
    // at the knob extremes (default 0.5 ≈ a balanced 909 clap).
    const burstGain = 1 - 0.6 * mix; // 1.0 … 0.4
    const roomGain = 0.2 + 0.8 * mix; // 0.2 … 1.0

    const lastOnset = (bursts - 1) * spread;

    for (let i = from; i < to; i++) {
      const t = this.t;

      // Burst train: sum of per-transient AD envelopes; the j-th delayed by j*spread.
      let burst = 0;
      for (let j = 0; j < bursts; j++) {
        const td = t - j * spread;
        if (td >= 0) {
          const atk = td < 0.0005 ? td / 0.0005 : 1; // 0.5ms attack, no onset click
          burst += atk * Math.exp(-td / body);
        }
      }
      const roomEnv = Math.exp(-t / room);
      const env = burst * burstGain + roomEnv * roomGain;

      // Stop once the claps are over and the tail has decayed.
      if (t > lastOnset && env < 1e-4) {
        this.active = false;
        return; // remaining samples stay 0 (out was zero-filled)
      }

      // Bandpass the white noise (Chamberlin SVF; band output).
      const input = this.noise();
      this.svfLow += f * this.svfBand;
      const high = input - this.svfLow - q * this.svfBand;
      this.svfBand += f * high;
      const bp = this.svfBand;

      out[i] += bp * env * this.velocity * level * OUT_TRIM;
      this.t += dt;
    }
  }
}
