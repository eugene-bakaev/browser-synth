//
// SoundEngine implementation for the worklet synth (spec §6.1/§6.6). One
// AudioWorkletNode per engine instance; ALL communication is MessagePort
// messages (no AudioParams). The engine keeps a Float32Array mirror of the
// param block (descriptor order — see kernel/params.ts) and posts a copy
// whenever applyParams changes anything.
//
// External graph shape matches every other engine: node → out GainNode →
// destination, so useSynth's D4 engine-swap fade works unchanged.
//
// PREREQUISITE: ctx.audioWorklet.addModule(synth2 worklet URL) must have
// resolved before construction — same invariant as the pulse worklet; both
// are awaited in useSynth.buildAudioState.

import { SoundEngine } from './types';
import { DEFAULT_SYNTH2_PARAMS, type Synth2EngineParams } from '@fiddle/shared';
import { PARAM_INDEX, defaultParamBlock } from './synth2/kernel/params';

export class Synth2Engine implements SoundEngine {
  readonly engineType = 'synth2';
  readonly ctx: AudioContext;

  static readonly DEFAULT_PARAMS: Synth2EngineParams = DEFAULT_SYNTH2_PARAMS;

  private readonly node: AudioWorkletNode;
  private readonly out: GainNode;
  private readonly block = defaultParamBlock();

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'synth2', {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.node.connect(this.out);
    this.out.connect(destination ?? ctx.destination);
  }

  applyParams(params: Record<string, any>): void {
    let changed = false;
    for (const [mod, fields] of Object.entries(params)) {
      if (typeof fields !== 'object' || fields === null) continue;
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        if (typeof value !== 'number') continue;
        const idx = PARAM_INDEX[`${mod}.${field}`];
        if (idx === undefined) continue;
        // Float32Array stores 32-bit values; Math.fround converts the incoming
        // number to the same precision before comparing so the no-op path works
        // even when DEFAULT_SYNTH2_PARAMS values have 64-bit fractions that
        // round to the same float32 as the stored block entry.
        const f32 = Math.fround(value);
        if (this.block[idx] === f32) continue;
        this.block[idx] = f32;
        changed = true;
      }
    }
    if (changed) {
      this.node.port.postMessage({ type: 'params', block: this.block.slice() });
    }
  }

  trigger(freq: number | number[], duration: number, time?: number, velocity: number = 1.0): void {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // I1 is mono — chords collapse to their root; poly arrives in I2.
    const f = Array.isArray(freq) ? freq[0] : freq;
    this.node.port.postMessage({
      type: 'trigger',
      time: time ?? this.ctx.currentTime,
      freq: f,
      duration,
      velocity,
    });
  }

  dispose(): void {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.out.disconnect();
  }
}
