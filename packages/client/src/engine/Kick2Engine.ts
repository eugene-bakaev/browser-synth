//
// SoundEngine host for the kick2 worklet. One AudioWorkletNode('kick2') per
// instance; all communication is MessagePort messages (no AudioParams). Keeps a
// Float32Array mirror of the param block (descriptor order — kick2/kernel/params)
// and posts a copy whenever applyParams changes anything. External graph shape
// matches every other engine: node → out GainNode → destination, so useSynth's
// D4 engine-swap fade works unchanged.
//
// PREREQUISITE: ctx.audioWorklet.addModule(kick2 worklet URL) must have resolved
// before construction — awaited in useSynth.buildAudioState alongside synth2.

import { SoundEngine } from './types';
import { DEFAULT_KICK2_PARAMS, type Kick2EngineParams } from '@fiddle/shared';
import { PARAM_INDEX, defaultParamBlock } from './kick2/kernel/params';

// Re-export so consumers can `import { Kick2EngineParams } from '../engine/Kick2Engine'`.
export type { Kick2EngineParams } from '@fiddle/shared';

export class Kick2Engine implements SoundEngine {
  readonly engineType = 'kick2';
  readonly ctx: AudioContext;

  static readonly DEFAULT_PARAMS: Kick2EngineParams = DEFAULT_KICK2_PARAMS;

  private readonly node: AudioWorkletNode;
  private readonly out: GainNode;
  private readonly block = defaultParamBlock();

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'kick2', {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.node.connect(this.out);
    this.out.connect(destination ?? ctx.destination);
  }

  applyParams(params: Record<string, any>): void {
    let changed = false;
    for (const [field, value] of Object.entries(params)) {
      const idx = PARAM_INDEX[field];
      // Math.fround so the no-op check matches the float32 the block stores even
      // when DEFAULT_KICK2_PARAMS carries a 64-bit fraction.
      if (idx === undefined || typeof value !== 'number') continue;
      const f32 = Math.fround(value);
      if (this.block[idx] === f32) continue;
      this.block[idx] = f32;
      changed = true;
    }
    if (changed) {
      this.node.port.postMessage({ type: 'params', block: this.block.slice() });
    }
  }

  trigger(_freq: number | number[], duration: number, time?: number, velocity: number = 1.0): void {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = time ?? this.ctx.currentTime;
    this.node.port.postMessage({ type: 'trigger', time: t, duration, velocity });
  }

  dispose(): void {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.out.disconnect();
  }
}
