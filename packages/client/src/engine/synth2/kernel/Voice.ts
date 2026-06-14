//
// THE PATCH (spec §6.3): the only file that instantiates modules and wires
// them together. I2c-2 voice: osc1 + osc2 + osc3 + noise → 4-channel mixer →
// ClassicFilter → VCA(env1) → out. TZFM chain: osc1 modulates osc2, osc2
// modulates osc3. env2 is hardwired to cutoff (envAmount·env2 → octave shift).
// Each voice owns its own ParamSlot set (bases are broadcast by the kernel;
// per-voice modulation arrives with the matrix in I3).

import { ParamSlot } from './ParamSlot';
import { MorphOscillator } from './MorphOscillator';
import { LoopEnvelope } from './LoopEnvelope';
import { Noise } from './Noise';
import { ClassicFilter } from './ClassicFilter';
import { PARAM_INDEX } from './params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

// Keytrack reference pitch: keyTrack 1 makes cutoff track the note 1:1 about C4.
const KEYTRACK_REF_HZ = 261.6256;

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
  private osc2Sync = false;
  private osc3Sync = false;
  private readonly env2: LoopEnvelope;
  private readonly filter: ClassicFilter;
  private readonly cutoffSlot: ParamSlot;
  private readonly resSlot: ParamSlot;
  private readonly keyTrackSlot: ParamSlot;
  private readonly envAmountSlot: ParamSlot;
  private keyTrackOctaves = 0; // log2(freq / C4), cached per note

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
    this.env2 = new LoopEnvelope(
      slot('env2.a'), slot('env2.d'), slot('env2.s'), slot('env2.r'), sampleRate,
    );
    this.filter = new ClassicFilter(sampleRate);
    this.cutoffSlot = slot('filter.cutoff');
    this.resSlot = slot('filter.resonance');
    this.keyTrackSlot = slot('filter.keyTrack');
    this.envAmountSlot = slot('filter.envAmount');
  }

  /** Block-boundary discrete update: osc2 syncs to osc1's wraps, osc3 to osc2's.
   *  (osc1.sync is inert — osc1 is the master.) */
  setSync(osc2Sync: boolean, osc3Sync: boolean): void {
    this.osc2Sync = osc2Sync;
    this.osc3Sync = osc3Sync;
  }

  /** Block-boundary discrete update: select LP(0)/BP(1)/HP(2). */
  setFilterType(type: number): void {
    this.filter.setType(type);
  }

  get active(): boolean {
    return this.env1.active;
  }

  noteOn(freq: number, velocity: number, gateFrames: number): void {
    this.freq = freq;
    this.velocity = velocity < 0 ? 0 : velocity > 1 ? 1 : velocity;
    this.keyTrackOctaves = Math.log2(freq / KEYTRACK_REF_HZ);
    if (!this.env1.active) {
      this.osc1.reset(); this.osc2.reset(); this.osc3.reset();
      this.filter.reset();
    }
    this.env1.noteOn(gateFrames);
    this.env2.noteOn(gateFrames);
  }

  /** Adds into out[from..to). Caller must skip inactive voices (gating). */
  renderAdd(out: Float32Array, from: number, to: number): void {
    for (let n = from; n < to; n++) {
      const e = this.env1.next();
      const env2v = this.env2.next();
      // TZFM + hard-sync chain: osc1 master → osc2 → osc3. Each ParamSlot.next()
      // called exactly once per sample. A slave resets when its master wrapped
      // this sample AND its sync toggle is on.
      const o1 = this.osc1.next(this.freq);
      const o2 = this.osc2.next(
        this.freq, o1, this.fmOsc2.next(),
        this.osc2Sync && this.osc1.wrapped ? this.osc1.wrapFrac : -1,
      );
      const o3 = this.osc3.next(
        this.freq, o2, this.fmOsc3.next(),
        this.osc3Sync && this.osc2.wrapped ? this.osc2.wrapFrac : -1,
      );
      const nz = this.noise.next(this.noiseColor.next());
      const mix =
        o1 * this.osc1Level.next() +
        o2 * this.osc2Level.next() +
        o3 * this.osc3Level.next() +
        nz * this.noiseLevel.next();
      // Hardwired cutoff routing (spec §5.3), all in octaves about the base
      // cutoff: keytrack follows the note pitch; env2 (0..1) scaled by the
      // bipolar envAmount (±4 oct). Each ParamSlot.next() called exactly once.
      const octShift =
        this.keyTrackSlot.next() * this.keyTrackOctaves + this.envAmountSlot.next() * env2v;
      let fc = this.cutoffSlot.next() * Math.pow(2, octShift); // I4: Math.pow → approx (cf. SvfCore tan)
      if (fc < 20) fc = 20; else if (fc > 20000) fc = 20000;
      const filtered = this.filter.process(mix, fc, this.resSlot.next());
      out[n] += filtered * e * this.velocity;
    }
  }
}
