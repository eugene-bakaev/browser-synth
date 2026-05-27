import { Module, ModulePort } from '../types';

export class FilterModule implements Module {
  readonly name = 'Filter';
  private filter: BiquadFilterNode;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.inputs = { 
        main: this.filter,
        cutoff: this.filter.frequency,
        resonance: this.filter.Q
    };
    this.outputs = { main: this.filter };
  }
}
