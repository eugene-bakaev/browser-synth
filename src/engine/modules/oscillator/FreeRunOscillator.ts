import type { ModulePort, Module } from '../../types';
import type { IOscillatorModule } from './types';

export class FreeRunOscillator implements IOscillatorModule, Module {
  readonly name = 'Oscillator';
  private osc: OscillatorNode;
  private gain: GainNode;

  coarseTune: number = 0; // -3..+3 octaves
  private baseFreq: number = 440;

  readonly inputs: Record<string, ModulePort> = {};
  readonly outputs: { main: GainNode };

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

  // Free-run delegates triggerAt to setFrequencyAtTime — the steady-state
  // path is identical to today's behavior; releaseTime is unused because the
  // osc never stops until dispose().
  triggerAt(freq: number, time: number, _releaseTime: number) {
    this.setFrequencyAtTime(freq, time);
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
    this.setFrequencyAtTime(this.baseFreq, this.osc.context.currentTime);
  }

  setFineTune(cents: number) {
    this.osc.detune.setValueAtTime(cents, this.osc.context.currentTime);
  }

  setWaveform(type: OscillatorType) {
    this.osc.type = type;
  }

  // Documented no-op — free-run mode does not control phase.
  setPhase(_degrees: number) {
    /* no-op */
  }

  dispose() {
    try {
      this.osc.stop();
    } catch {
      // already stopped
    }
    this.osc.disconnect();
    this.gain.disconnect();
  }
}
