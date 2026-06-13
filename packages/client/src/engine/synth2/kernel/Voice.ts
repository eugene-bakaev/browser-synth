//
// THE PATCH (spec §6.3): the only file that instantiates modules and wires
// them together. I1 voice: osc1 → level → VCA(env1) → out. Each voice owns
// its own ParamSlot set (bases are broadcast by the kernel; per-voice
// modulation arrives with the matrix in I3).

import { ParamSlot } from './ParamSlot';
import { MorphOscillator } from './MorphOscillator';
import { LoopEnvelope } from './LoopEnvelope';
import { PARAM_INDEX } from './params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

export class Voice {
  readonly slots: ParamSlot[];

  private readonly osc1: MorphOscillator;
  private readonly env1: LoopEnvelope;
  private readonly osc1Level: ParamSlot;
  private freq = 440;
  private velocity = 1;

  constructor(sampleRate: number) {
    this.slots = SYNTH2_DESCRIPTORS.map(d => new ParamSlot(d, sampleRate));
    const slot = (key: string): ParamSlot => this.slots[PARAM_INDEX[key]];

    this.osc1 = new MorphOscillator(
      slot('osc1.morph'), slot('osc1.pulseWidth'),
      slot('osc1.coarse'), slot('osc1.fine'), sampleRate,
    );
    this.osc1Level = slot('osc1.level');
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
    if (!this.env1.active) this.osc1.reset(); // fresh start; steals keep phase (D3 ramp handles the level)
    this.env1.noteOn(gateFrames);
  }

  /** Adds into out[from..to). Caller must skip inactive voices (gating). */
  renderAdd(out: Float32Array, from: number, to: number): void {
    for (let n = from; n < to; n++) {
      const e = this.env1.next();
      out[n] += this.osc1.next(this.freq) * this.osc1Level.next() * e * this.velocity;
    }
  }
}
