//
// kick2 DSP kernel — pure TS, no AudioContext (unit-testable like Synth2Kernel).
// process(out, frames, blockStartFrame) renders the bass drum into `out`.
//
// Synthesis (SOS "Synth Secrets", bass drum): a sine body with a downward PITCH
// envelope (start = tune·(1+punch·7) → tune over `pitchDecay`), a waveshaper
// DRIVE for the "thwack", a fast noise CLICK transient, an amplitude AD env, and
// an 808-style DROOP that lets the pitch sag slightly across a long decay. The
// voice is monophonic: a retrigger restarts it (a kick is a one-shot, so the
// incoming note pitch/duration are ignored — the voice tunes itself from params).

import { PARAM_COUNT, PARAM_INDEX, defaultParamBlock } from './params';

const MAX_EVENTS = 16;
const TWO_PI = Math.PI * 2;
const I_TUNE = PARAM_INDEX['tune'];
const I_PUNCH = PARAM_INDEX['punch'];
const I_PITCH_DECAY = PARAM_INDEX['pitchDecay'];
const I_DECAY = PARAM_INDEX['decay'];
const I_CLICK = PARAM_INDEX['click'];
const I_DRIVE = PARAM_INDEX['drive'];
const I_DROOP = PARAM_INDEX['droop'];
const I_LEVEL = PARAM_INDEX['level'];

interface HitEvent {
  frame: number;
  velocity: number;
}

export class Kick2Kernel {
  private readonly block = defaultParamBlock();
  private readonly events: HitEvent[];
  private head = 0; // next event to consume
  private count = 0;

  // Mono voice state (a retrigger restarts it).
  private active = false;
  private phase = 0; // body oscillator phase, radians
  private t = 0; // seconds since the current trigger
  private velocity = 1;

  // Deterministic xorshift32 noise for the click transient (seeded so tests are
  // reproducible). Never 0.
  private rng = 0x6d2b79f5;

  constructor(private readonly sampleRate: number) {
    this.events = Array.from({ length: MAX_EVENTS }, () => ({ frame: 0, velocity: 1 }));
  }

  /** Full param block (base values, descriptor order). Non-finite entries are
   *  ignored so a garbage value can't poison the voice. */
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) {
      const v = block[i];
      if (Number.isFinite(v)) this.block[i] = v;
    }
  }

  /** time in seconds on the AudioContext clock (SoundEngine contract). freq and
   *  duration are ignored — a drum voices its own pitch and length from params. */
  noteOn(time: number, _freq: number, _duration: number, velocity: number): void {
    const vel = Number.isFinite(velocity) ? (velocity < 0 ? 0 : velocity > 1 ? 1 : velocity) : 1;
    const t = Number.isFinite(time) ? time : 0;
    if (this.count === MAX_EVENTS) {
      // drop oldest
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
    this.phase = 0;
    this.t = 0;
    this.velocity = velocity;
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

    const tune = this.block[I_TUNE];
    const punch = this.block[I_PUNCH];
    const pitchDecay = Math.max(0.001, this.block[I_PITCH_DECAY]);
    const ampDecay = Math.max(0.01, this.block[I_DECAY]);
    const click = this.block[I_CLICK];
    const drive = this.block[I_DRIVE];
    const droop = this.block[I_DROOP];
    const level = this.block[I_LEVEL];

    const startMul = 1 + punch * 7; // pitch sweep starts at tune·startMul
    const driveGain = 1 + drive * 6;
    const driveNorm = 1 / Math.tanh(driveGain); // keep peak ~unity across drive
    const ampK = 6.9 / ampDecay; // exp decay reaches ~-60 dB at t = ampDecay
    const clickTau = 0.004; // 4 ms click transient

    for (let i = from; i < to; i++) {
      const t = this.t;

      // Voice ends once the amp env is inaudible and we're past the decay.
      const decayEnv = Math.exp(-t * ampK);
      if (t > 0 && decayEnv < 1e-4) {
        this.active = false;
        return; // remaining samples stay 0 (out was zero-filled)
      }

      // Pitch envelope + 808 droop (a small downward drift over the decay).
      const pEnv = Math.exp(-t / pitchDecay);
      const droopMul = 1 - droop * 0.06 * Math.min(1, t / ampDecay);
      const pitch = tune * (1 + (startMul - 1) * pEnv) * droopMul;
      this.phase += TWO_PI * pitch * dt;
      if (this.phase >= TWO_PI) this.phase -= TWO_PI;

      // Body with waveshaper drive, normalised so peak stays ~unity.
      const body = Math.tanh(Math.sin(this.phase) * driveGain) * driveNorm;

      // Click: a fast-decaying noise burst at the very start.
      const clickSig = this.noise() * click * Math.exp(-t / clickTau);

      // Amplitude AD: linear 2 ms attack into the exponential decay.
      const attack = t < 0.002 ? t / 0.002 : 1;
      const amp = attack * decayEnv;

      out[i] += (body * amp + clickSig) * this.velocity * level;

      this.t += dt;
    }
  }
}
