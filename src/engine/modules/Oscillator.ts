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

  setFrequencyAtTime(freq: number, time: number) {
    this.baseFreq = freq;
    const finalFreq = this.baseFreq * Math.pow(2, this.coarseTune);
    this.osc.frequency.setValueAtTime(finalFreq, time);
  }

  setFrequency(freq: number) {
    this.setFrequencyAtTime(freq, this.osc.context.currentTime);
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
    this.setFrequency(this.baseFreq);
  }

  setFineTune(cents: number) {
    this.osc.detune.setValueAtTime(cents, this.osc.context.currentTime);
  }

  setWaveform(type: OscillatorType) {
    this.osc.type = type;
  }

  dispose() {
    try {
      this.osc.stop();
    } catch (e) {
      // already stopped or not started
    }
    this.osc.disconnect();
    this.gain.disconnect();
  }
}
