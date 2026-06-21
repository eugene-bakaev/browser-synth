//
// The ONLY snare2 file that touches AudioWorkletGlobalScope. Bundled by esbuild
// into public/worklets/snare2-processor.js (package.json build:worklet) and
// registered in useSynth.buildAudioState via addModule before any Snare2Engine
// constructs an AudioWorkletNode('snare2'). Message protocol mirrors kick2:
//   { type: 'params',  block: Float32Array }
//   { type: 'trigger', time, duration, velocity }   seconds on the ctx clock
//   { type: 'dispose' }   → process() returns false, node becomes collectable

import { Snare2Kernel } from './kernel/Snare2Kernel';

type Snare2Message =
  | { type: 'params'; block: Float32Array }
  | { type: 'trigger'; time: number; duration: number; velocity: number }
  | { type: 'dispose' };

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

class Snare2Processor extends AudioWorkletProcessor {
  private readonly kernel = new Snare2Kernel(sampleRate);
  private alive = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as Snare2Message;
      if (msg.type === 'params') {
        this.kernel.applyParams(msg.block);
      } else if (msg.type === 'trigger') {
        this.kernel.noteOn(msg.time, 0, msg.duration, msg.velocity);
      } else if (msg.type === 'dispose') {
        this.alive = false;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const mono = channels?.[0];
    if (!channels || !mono) return this.alive;
    this.kernel.process(mono, mono.length, currentFrame);
    for (let c = 1; c < channels.length; c++) channels[c].set(mono);
    return this.alive;
  }
}

registerProcessor('snare2', Snare2Processor);
