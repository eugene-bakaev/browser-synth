//
// snare2 DSP kernel — pure TS, no AudioContext (unit-testable like Kick2Kernel).
// process(out, frames, blockStartFrame) renders the snare drum into `out`.
//
// Synthesis (SOS "Synth Secrets", snare drum): two tuned shell modes (a sine at
// `tune` plus an enharmonic partial ~1.83× above it, quieter and shorter) summed
// for the drum "body", crossfaded by `snappy` against a two-band noise path — a
// `tone`-lowpassed "body" noise band that dies fast (bodyNoiseDecay) and a
// `noiseHp`-highpassed "wires" band that rings on `noiseDecay`. The voice is
// monophonic: a retrigger restarts it (a snare is a one-shot, so the incoming
// note pitch/duration are ignored — the voice tunes itself from params).

import { PARAM_COUNT, PARAM_INDEX, defaultParamBlock } from './params';

const MAX_EVENTS = 16;
const TWO_PI = Math.PI * 2;
const SHELL_RATIO = 1.83; // upper shell mode, relative to `tune`

const I_TUNE = PARAM_INDEX['tune'];
const I_BODY_DECAY = PARAM_INDEX['bodyDecay'];
const I_NOISE_DECAY = PARAM_INDEX['noiseDecay'];
const I_SNAPPY = PARAM_INDEX['snappy'];
const I_TONE = PARAM_INDEX['tone'];
const I_NOISE_HP = PARAM_INDEX['noiseHp'];
const I_LEVEL = PARAM_INDEX['level'];

interface HitEvent {
  frame: number;
  velocity: number;
}

export class Snare2Kernel {
  private readonly block = defaultParamBlock();
  private readonly events: HitEvent[];
  private head = 0; // next event to consume
  private count = 0;

  // Mono voice state (a retrigger restarts it).
  private active = false;
  private phase1 = 0; // fundamental shell phase, radians
  private phase2 = 0; // upper-mode shell phase, radians
  private t = 0; // seconds since the current trigger
  private velocity = 1;
  private lpTone = 0; // one-pole state — noise body band (lowpass at `tone`)
  private lpHp = 0; // one-pole state — feeds the wires highpass (white − lp)

  // Deterministic xorshift32 noise (seeded so tests are reproducible). Never 0.
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
    this.phase1 = 0;
    this.phase2 = 0;
    this.t = 0;
    this.velocity = velocity;
    this.lpTone = 0;
    this.lpHp = 0;
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
    const nyq = sr * 0.45;

    const tune = this.block[I_TUNE];
    const bodyDecay = Math.max(0.005, this.block[I_BODY_DECAY]);
    const noiseDecay = Math.max(0.005, this.block[I_NOISE_DECAY]);
    const snappy = Math.min(1, Math.max(0, this.block[I_SNAPPY]));
    const tone = this.block[I_TONE];
    const noiseHp = Math.min(1, Math.max(0, this.block[I_NOISE_HP]));
    const level = this.block[I_LEVEL];

    const upperDecay = bodyDecay * 0.6; // higher mode dies faster
    const bodyNoiseDecay = noiseDecay * 0.5; // body noise dies before the wires
    const hpCut = 300 + noiseHp * 4700; // 300..5000 Hz wires highpass

    // one-pole coefficients (cutoff clamped below ~Nyquist for stability)
    const aTone = 1 - Math.exp(-TWO_PI * Math.min(tone, nyq) * dt);
    const aHp = 1 - Math.exp(-TWO_PI * Math.min(hpCut, nyq) * dt);

    // voice kill once the longest decay is inaudible (~-60 dB)
    const tailK = 6.9 / Math.max(bodyDecay, noiseDecay);

    for (let i = from; i < to; i++) {
      const t = this.t;

      const tail = Math.exp(-t * tailK);
      if (t > 0 && tail < 1e-4) {
        this.active = false;
        return; // remaining samples stay 0 (out was zero-filled)
      }

      // --- shell: two tuned modes (drum "body") ---
      this.phase1 += TWO_PI * tune * dt;
      if (this.phase1 >= TWO_PI) this.phase1 -= TWO_PI;
      this.phase2 += TWO_PI * tune * SHELL_RATIO * dt;
      if (this.phase2 >= TWO_PI) this.phase2 -= TWO_PI;
      const shellEnv = Math.exp(-t / bodyDecay);
      const upperEnv = Math.exp(-t / upperDecay);
      const shell =
        (Math.sin(this.phase1) * shellEnv + Math.sin(this.phase2) * 0.6 * upperEnv) * 0.7;

      // --- noise: two bands from one white source ---
      const white = this.noise();
      this.lpTone += aTone * (white - this.lpTone); // body band = lowpass(white, tone)
      this.lpHp += aHp * (white - this.lpHp); // track lp at hpCut so white−lp = highpass
      const bodyNoise = this.lpTone * Math.exp(-t / bodyNoiseDecay);
      const wires = (white - this.lpHp) * Math.exp(-t / noiseDecay);
      const noiseSig = bodyNoise * 0.6 + wires;

      // crossfade shell vs noise; a 1 ms attack ramp avoids an onset click
      const attack = t < 0.001 ? t / 0.001 : 1;
      const mix = shell * (1 - snappy) + noiseSig * snappy;

      out[i] += mix * attack * this.velocity * level;

      this.t += dt;
    }
  }
}
