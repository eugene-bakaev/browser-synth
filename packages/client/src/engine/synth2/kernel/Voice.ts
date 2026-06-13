//
// THE PATCH (spec §6.3): the only file that instantiates modules and wires
// them together. I2b voice: osc1 + osc2 + osc3 + noise → 4-channel mixer →
// VCA(env1) → out. TZFM chain: osc1 modulates osc2, osc2 modulates osc3.
// Each voice owns its own ParamSlot set (bases are broadcast by the kernel;
// per-voice modulation arrives with the matrix in I3).

import { ParamSlot } from './ParamSlot';
import { MorphOscillator } from './MorphOscillator';
import { LoopEnvelope } from './LoopEnvelope';
import { Noise } from './Noise';
import { PARAM_INDEX } from './params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

export class Voice {
  readonly slots: ParamSlot[];

  private readonly osc1: MorphOscillator;
  private readonly osc2: MorphOscillator;
  private readonly osc3: MorphOscillator;
  private readonly env1: LoopEnvelope;
  private readonly osc1Level: ParamSlot;
  private readonly osc2Level: ParamSlot;
  private readonly osc3Level: ParamSlot;
  private readonly noiseLevel: ParamSlot;
  private readonly noiseColor: ParamSlot;
  private readonly fmOsc2: ParamSlot;
  private readonly fmOsc3: ParamSlot;
  private readonly noise: Noise;
  private freq = 440;
  private velocity = 1;

  constructor(sampleRate: number, seed = 1) {
    this.slots = SYNTH2_DESCRIPTORS.map(d => new ParamSlot(d, sampleRate));
    const slot = (key: string): ParamSlot => this.slots[PARAM_INDEX[key]];

    this.osc1 = new MorphOscillator(slot('osc1.morph'), slot('osc1.pulseWidth'), slot('osc1.coarse'), slot('osc1.fine'), sampleRate);
    this.osc2 = new MorphOscillator(slot('osc2.morph'), slot('osc2.pulseWidth'), slot('osc2.coarse'), slot('osc2.fine'), sampleRate);
    this.osc3 = new MorphOscillator(slot('osc3.morph'), slot('osc3.pulseWidth'), slot('osc3.coarse'), slot('osc3.fine'), sampleRate);
    this.osc1Level = slot('osc1.level');
    this.osc2Level = slot('osc2.level');
    this.osc3Level = slot('osc3.level');
    this.noiseLevel = slot('noise.level');
    this.noiseColor = slot('noise.color');
    this.fmOsc2 = slot('fm.osc2');
    this.fmOsc3 = slot('fm.osc3');
    this.noise = new Noise(seed);
    this.env1 = new LoopEnvelope(
      slot('env1.a'), slot('env1.d'), slot('env1.s'), slot('env1.r'), sampleRate,
    );
  }

  get active(): boolean {
    return this.env1.active;
  }

  noteOn(freq: number, velocity: number, gateFrames: number): void {
    this.freq = freq;
    this.velocity = velocity < 0 ? 0 : velocity > 1 ? 1 : velocity;
    if (!this.env1.active) { this.osc1.reset(); this.osc2.reset(); this.osc3.reset(); } // fresh start; steals keep phase (D3 ramp handles the level)
    this.env1.noteOn(gateFrames);
  }

  /** Adds into out[from..to). Caller must skip inactive voices (gating). */
  renderAdd(out: Float32Array, from: number, to: number): void {
    for (let n = from; n < to; n++) {
      const e = this.env1.next();
      // TZFM chain: osc1 → osc2 → osc3. Every ParamSlot.next() called exactly once per sample.
      const o1 = this.osc1.next(this.freq);
      const o2 = this.osc2.next(this.freq, o1, this.fmOsc2.next());
      const o3 = this.osc3.next(this.freq, o2, this.fmOsc3.next());
      const nz = this.noise.next(this.noiseColor.next());
      const mix =
        o1 * this.osc1Level.next() +
        o2 * this.osc2Level.next() +
        o3 * this.osc3Level.next() +
        nz * this.noiseLevel.next();
      out[n] += mix * e * this.velocity;
    }
  }
}
