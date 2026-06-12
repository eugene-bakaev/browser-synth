//
// The ONLY file that touches AudioWorkletGlobalScope (spec §6.2). Bundled by
// esbuild into public/worklets/synth2-processor.js (see package.json
// build:worklet) and registered in useSynth.buildAudioState via addModule.
//
// Message protocol (spec §6.6):
//   { type: 'params',  block: Float32Array }   full base-value block
//   { type: 'trigger', time, freq, duration, velocity }   seconds on ctx clock
//   { type: 'dispose' }   → process() returns false, node becomes collectable

import { Synth2Kernel } from './kernel/Synth2Kernel';

// AudioWorkletGlobalScope members — not in the DOM lib TS ships for the page.
declare const sampleRate: number;
declare const currentFrame: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

class Synth2Processor extends AudioWorkletProcessor {
  private readonly kernel = new Synth2Kernel(sampleRate);
  private alive = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'params') {
        this.kernel.applyParams(msg.block);
      } else if (msg.type === 'trigger') {
        this.kernel.noteOn(msg.time, msg.freq, msg.duration, msg.velocity);
      } else if (msg.type === 'dispose') {
        this.alive = false;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const mono = channels[0];
    if (!mono) return this.alive;
    this.kernel.process(mono, mono.length, currentFrame);
    for (let c = 1; c < channels.length; c++) channels[c].set(mono);
    return this.alive;
  }
}

registerProcessor('synth2', Synth2Processor);
