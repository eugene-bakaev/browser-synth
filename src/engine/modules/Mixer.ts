import { Module, ModulePort } from '../types';

export class MixerModule implements Module {
  readonly name = 'Mixer';
  private gain: GainNode;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.gain = ctx.createGain();
    this.inputs = { main: this.gain };
    this.outputs = { main: this.gain };
  }
}
