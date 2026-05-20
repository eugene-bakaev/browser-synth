import { Module, ModulePort } from '../types';

export class OscillatorModule implements Module {
  readonly name = 'Oscillator';
  private osc: OscillatorNode;
  private gain: GainNode;
  
  coarseTune: number = 0; // -3 to +3 octaves
  private baseFreq: number = 440;

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
    this.baseFreq = freq;
    this.updateFrequency();
  }

  private updateFrequency() {
    const freq = this.baseFreq * Math.pow(2, this.coarseTune);
    this.osc.frequency.setValueAtTime(freq, 0); // Using 0 for immediate change in this prototype
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
    this.updateFrequency();
  }

  setFineTune(cents: number) {
    this.osc.detune.setValueAtTime(cents, 0);
  }

  setWaveform(type: OscillatorType) {
    this.osc.type = type;
  }
}
