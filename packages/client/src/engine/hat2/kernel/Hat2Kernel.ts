//
// hat2 DSP kernel — pure TS, no AudioContext (unit-testable like Kick2Kernel /
// Snare2Kernel). process(out, frames, blockStartFrame) renders the hi-hat into `out`.
//
// Synthesis (SOS "Synth Secrets", metallic percussion): six enharmonic square
// oscillators at the documented TR-808 cluster, summed; `ring` blends in a ring-mod
// between two members (clang); the cluster is crossfaded by `metallic` against white
// noise; the whole source is band-shaped by a 1-pole highpass (`hpf`) then a 1-pole
// top-tilt lowpass (`tone`); an AD amp env (`decay` = closed↔open length) shapes the
// tail. Monophonic: a retrigger restarts it (note pitch/duration ignored — the voice
// tunes itself from params and the fixed cluster).

import { PARAM_COUNT, PARAM_INDEX, defaultParamBlock } from './params';

const MAX_EVENTS = 16;
const TWO_PI = Math.PI * 2;
// Documented TR-808 hi-hat square-cluster frequencies (reused from the analog
// HatEngine). Enharmonic on purpose — the inharmonic beating is the metal timbre.
const CLUSTER = [205.3, 369.6, 304.4, 522.7, 370.0, 800.0];

const I_TONE = PARAM_INDEX['tone'];
const I_DECAY = PARAM_INDEX['decay'];
const I_HPF = PARAM_INDEX['hpf'];
const I_METALLIC = PARAM_INDEX['metallic'];
const I_RING = PARAM_INDEX['ring'];
const I_LEVEL = PARAM_INDEX['level'];

interface HitEvent {
  frame: number;
  velocity: number;
}

export class Hat2Kernel {
  private readonly block = defaultParamBlock();
  private readonly events: HitEvent[];
  private head = 0;
  private count = 0;

  // Mono voice state (a retrigger restarts it).
  private active = false;
  private readonly phases = new Float64Array(CLUSTER.length); // per-square phase, radians
  private t = 0;
  private velocity = 1;
  private hpPrevIn = 0; // 1-pole highpass state
  private hpPrevOut = 0;
  private lpTone = 0; // 1-pole lowpass (tone) state

  // Deterministic xorshift32 noise (seeded so tests are reproducible). Never 0.
  private rng = 0x6d2b79f5;

  constructor(private readonly sampleRate: number) {
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
   *  voices its own pitch and length from params. */
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
    this.phases.fill(0);
    this.t = 0;
    this.velocity = velocity;
    this.hpPrevIn = 0;
    this.hpPrevOut = 0;
    this.lpTone = 0;
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

    const tone = this.block[I_TONE];
    const decay = Math.max(0.005, this.block[I_DECAY]);
    const hpf = this.block[I_HPF];
    const metallic = Math.min(1, Math.max(0, this.block[I_METALLIC]));
    const ring = Math.min(1, Math.max(0, this.block[I_RING]));
    const level = this.block[I_LEVEL];

    // 1-pole RC highpass coefficient: y = hpA·(yPrev + x − xPrev).
    const hpA = 1 / (1 + TWO_PI * Math.min(hpf, nyq) * dt);
    // 1-pole lowpass (top tilt) coefficient.
    const aTone = 1 - Math.exp(-TWO_PI * Math.min(tone, nyq) * dt);

    const ampK = 6.9 / decay; // exp decay reaches ~-60 dB at t = decay
    const nClus = CLUSTER.length;

    for (let i = from; i < to; i++) {
      const t = this.t;
      const env = Math.exp(-t * ampK);
      if (t > 0 && env < 1e-4) {
        this.active = false;
        return; // remaining samples stay 0 (out was zero-filled)
      }

      // six enharmonic squares; capture members 0 and 3 for the ring-mod
      let sum = 0;
      let s0 = 0;
      let s3 = 0;
      for (let k = 0; k < nClus; k++) {
        let ph = this.phases[k] + TWO_PI * CLUSTER[k] * dt;
        if (ph >= TWO_PI) ph -= TWO_PI;
        this.phases[k] = ph;
        const sq = Math.sin(ph) >= 0 ? 1 : -1;
        sum += sq;
        if (k === 0) s0 = sq;
        else if (k === 3) s3 = sq;
      }
      const ringMod = s0 * s3;
      const cluster = (sum / nClus) * (1 - ring) + ringMod * ring;

      // crossfade metal cluster vs white noise, then band-shape the whole source
      const src = cluster * metallic + this.noise() * (1 - metallic);

      // 1-pole highpass at hpf
      const hp = hpA * (this.hpPrevOut + src - this.hpPrevIn);
      this.hpPrevIn = src;
      this.hpPrevOut = hp;

      // 1-pole top-tilt lowpass at tone (HP ∩ LP = the metallic band)
      this.lpTone += aTone * (hp - this.lpTone);

      // 0.5 ms attack ramp avoids an onset click
      const attack = t < 0.0005 ? t / 0.0005 : 1;

      out[i] += this.lpTone * attack * env * this.velocity * level;
      this.t += dt;
    }
  }
}
