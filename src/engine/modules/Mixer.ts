import { Module, ModulePort } from '../types';

export class MixerModule implements Module {
  readonly name = 'Mixer';
  private outGain: GainNode;
  private ch1Gain: GainNode;
  private ch2Gain: GainNode;
  
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.outGain = ctx.createGain();
    this.ch1Gain = ctx.createGain();
    this.ch2Gain = ctx.createGain();
    
    this.ch1Gain.connect(this.outGain);
    this.ch2Gain.connect(this.outGain);
    
    // Default levels
    this.ch1Gain.gain.value = 0.5;
    this.ch2Gain.gain.value = 0.5;

    this.inputs = { 
        ch1: this.ch1Gain,
        ch2: this.ch2Gain
    };
    this.outputs = { main: this.outGain };
  }

  setChannelGain(channel: 1 | 2, val: number) {
    const time = this.outGain.context.currentTime;
    if (channel === 1) this.ch1Gain.gain.setValueAtTime(val, time);
    if (channel === 2) this.ch2Gain.gain.setValueAtTime(val, time);
  }
}
