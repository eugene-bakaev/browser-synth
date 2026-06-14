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
import { DEFAULT_SYNTH2_PARAMS, encodeBool, encodeEnum, SYNTH2_ENUM_VALUES, type Synth2EngineParams } from '@fiddle/shared';
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
        const idx = PARAM_INDEX[`${mod}.${field}`];
        if (idx === undefined) continue;
        // Continuous params arrive as numbers; discrete bools as true/false
        // (encoded 0/1); enum leaves as their string value (encoded to the
        // descriptor's index). Top-level strings (mode) never reach this nested
        // loop, so an unrecognised string here is skipped defensively.
        // Float32Array stores 32-bit values; Math.fround converts the incoming
        // number to the same precision before comparing so the no-op path works
        // even when DEFAULT_SYNTH2_PARAMS values have 64-bit fractions that
        // round to the same float32 as the stored block entry.
        let f32: number;
        if (typeof value === 'number') {
          f32 = Math.fround(value);
        } else if (typeof value === 'boolean') {
          f32 = encodeBool(value);
        } else if (typeof value === 'string') {
          const values = SYNTH2_ENUM_VALUES[`${mod}.${field}`];
          if (!values) continue;
          f32 = encodeEnum(value, values);
        } else {
          continue;
        }
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
    const t = time ?? this.ctx.currentTime;
    if (Array.isArray(freq)) {
      // Poly: one message per note; the kernel allocator spreads them across voices.
      for (const f of freq) {
        this.node.port.postMessage({ type: 'trigger', time: t, freq: f, duration, velocity, mono: false });
      }
    } else {
      // Mono: voice 0 retrigger.
      this.node.port.postMessage({ type: 'trigger', time: t, freq, duration, velocity, mono: true });
    }
  }

  dispose(): void {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.out.disconnect();
  }
}
