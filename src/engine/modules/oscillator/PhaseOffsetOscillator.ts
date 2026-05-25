import type { IOscillatorModule } from './types';
import { baseTable, rotatePhase } from './WaveformTables';

export class PhaseOffsetOscillator implements IOscillatorModule {
  private osc: OscillatorNode;
  private gain: GainNode;

  private ctx: AudioContext;
  private waveform: OscillatorType = 'sawtooth';
  private phaseDeg: number = 0;
  private coarseTune: number = 0;
  private baseFreq: number = 440;

  readonly outputs: { main: GainNode };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator();
    this.gain = ctx.createGain();
    this.osc.connect(this.gain);
    this.outputs = { main: this.gain };
    this.applyWave();
    this.osc.start();
  }

  private applyWave() {
    const rotated = rotatePhase(baseTable(this.waveform), this.phaseDeg);
    const wave = this.ctx.createPeriodicWave(rotated.real, rotated.imag, {
      disableNormalization: false,
    });
    this.osc.setPeriodicWave(wave);
  }

  setWaveform(type: OscillatorType) {
    this.waveform = type;
    this.applyWave();
  }

  setPhase(degrees: number) {
    // Wrap into [0, 360). Negative values OK from a knob but we normalize for
    // determinism in tests + log output.
    this.phaseDeg = ((degrees % 360) + 360) % 360;
    this.applyWave();
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
    this.setFrequencyAtTime(this.baseFreq, this.ctx.currentTime);
  }

  setFineTune(cents: number) {
    this.osc.detune.setValueAtTime(cents, this.ctx.currentTime);
  }

  setFrequencyAtTime(freq: number, time: number) {
    this.baseFreq = freq;
    const finalFreq = this.baseFreq * Math.pow(2, this.coarseTune);
    this.osc.frequency.setValueAtTime(finalFreq, time);
  }

  // Free-running: trigger is a frequency schedule, identical to FreeRun.
  triggerAt(freq: number, time: number, _releaseTime: number) {
    this.setFrequencyAtTime(freq, time);
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
