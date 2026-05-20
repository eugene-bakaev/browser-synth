import { Module, ModulePort } from '../types';

export class OscillatorModule implements Module {
  readonly name = 'Oscillator';
  private osc: OscillatorNode;
  private gain: GainNode;
  
  readonly inputs = {};
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.osc = ctx.createOscillator();
    this.gain = ctx.createGain();
    this.osc.connect(this.gain);
    this.osc.start();
    this.outputs = { main: this.gain };
  }

  setFrequency(freq: number) {
    this.osc.frequency.setValueAtTime(freq, 0);
  }

  setWaveform(type: OscillatorType) {
    this.osc.type = type;
  }
}
