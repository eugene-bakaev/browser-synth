import type { IOscillatorModule } from './types';
import { baseTable, rotatePhase } from './WaveformTables';

const STOP_TAIL_SECONDS = 0.05; // safety margin past ampEnv release

export class RetriggerOscillator implements IOscillatorModule {
  private ctx: AudioContext;
  // Output sink — patch bay connects to this; the per-trigger osc connects
  // into this gain on each trigger. Stays alive for the module's lifetime.
  private outGain: GainNode;

  private waveform: OscillatorType = 'sawtooth';
  private phaseDeg: number = 0;
  private coarseTune: number = 0;
  private fineCents: number = 0;

  readonly outputs: { main: GainNode };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.outGain = ctx.createGain();
    this.outputs = { main: this.outGain };
  }

  setWaveform(type: OscillatorType) { this.waveform = type; }
  setPhase(degrees: number) { this.phaseDeg = ((degrees % 360) + 360) % 360; }
  setCoarseTune(octaves: number) { this.coarseTune = octaves; }
  setFineTune(cents: number) { this.fineCents = cents; }

  // No live osc — retrigger model rebuilds the osc on each note-on, so a
  // mid-note frequency change has no source to write to. Cache; next
  // trigger uses it.
  setFrequencyAtTime(_freq: number, _time: number) { /* no-op */ }

  triggerAt(freq: number, time: number, releaseTime: number) {
    const osc = this.ctx.createOscillator();

    const rotated = rotatePhase(baseTable(this.waveform), this.phaseDeg);
    const wave = this.ctx.createPeriodicWave(rotated.real, rotated.imag, {
      disableNormalization: false,
    });
    osc.setPeriodicWave(wave);

    const finalFreq = freq * Math.pow(2, this.coarseTune);
    osc.frequency.setValueAtTime(finalFreq, time);
    osc.detune.setValueAtTime(this.fineCents, time);

    osc.connect(this.outGain);
    osc.start(time);
    osc.stop(releaseTime + STOP_TAIL_SECONDS);
    // GC via onended; no manual bookkeeping.
  }

  dispose() {
    this.outGain.disconnect();
  }
}
