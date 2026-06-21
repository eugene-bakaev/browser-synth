//
// The ONLY hat2 file that touches AudioWorkletGlobalScope. Bundled by esbuild into
// public/worklets/hat2-processor.js (package.json build:worklet) and registered in
// useSynth.buildAudioState via addModule before any Hat2Engine constructs an
// AudioWorkletNode('hat2'). Message protocol mirrors kick2/snare2:
//   { type: 'params',  block: Float32Array }
//   { type: 'trigger', time, duration, velocity }   seconds on the ctx clock
//   { type: 'dispose' }   → process() returns false, node becomes collectable

import { Hat2Kernel } from './kernel/Hat2Kernel';

type Hat2Message =
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

class Hat2Processor extends AudioWorkletProcessor {
  private readonly kernel = new Hat2Kernel(sampleRate);
  private alive = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as Hat2Message;
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

registerProcessor('hat2', Hat2Processor);
