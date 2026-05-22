import { PatchBay } from './PatchBay';
import { OscillatorModule } from './modules/Oscillator';
import { MixerModule } from './modules/Mixer';
import { FilterModule } from './modules/Filter';
import { EnvelopeModule } from './modules/Envelope';
import { SoundEngine } from './types';

export class SynthEngine implements SoundEngine {
  readonly engineType = 'synth';
  readonly ctx: AudioContext;
  private patchBay: PatchBay;
  
  private osc1: OscillatorModule;
  private osc2: OscillatorModule;
  private mixer: MixerModule;
  private filter: FilterModule;
  private ampEnv: EnvelopeModule;
  private filterEnv: EnvelopeModule;
  private masterVCA: GainNode;

  private baseCutoff: number = 2000;
  private filterEnvAmount: number = 3000;

  constructor(sharedCtx?: AudioContext) {
    this.ctx = sharedCtx ?? new AudioContext();
    this.patchBay = new PatchBay();
    
    this.osc1 = new OscillatorModule(this.ctx);
    this.osc2 = new OscillatorModule(this.ctx);
    this.mixer = new MixerModule(this.ctx);
    this.filter = new FilterModule(this.ctx);
    this.ampEnv = new EnvelopeModule();
    this.filterEnv = new EnvelopeModule();
    this.masterVCA = this.ctx.createGain();
    this.masterVCA.gain.value = 0;

    // Hardwired routing
    this.patchBay.connect(this.osc1.outputs.main, this.mixer.inputs.ch1);
    this.patchBay.connect(this.osc2.outputs.main, this.mixer.inputs.ch2);
    this.patchBay.connect(this.mixer.outputs.main, this.filter.inputs.main);
    this.patchBay.connect(this.filter.outputs.main, this.masterVCA);
    this.masterVCA.connect(this.ctx.destination);
  }

  // --- Setter methods (encapsulated API) ---

  setOsc1Type(type: OscillatorType) { this.osc1.setWaveform(type); }
  setOsc2Type(type: OscillatorType) { this.osc2.setWaveform(type); }

  setOsc1Coarse(val: number) { this.osc1.setCoarseTune(Math.max(-3, Math.min(3, val))); }
  setOsc1Fine(val: number) { this.osc1.setFineTune(Math.max(-100, Math.min(100, val))); }
  setOsc2Coarse(val: number) { this.osc2.setCoarseTune(Math.max(-3, Math.min(3, val))); }
  setOsc2Fine(val: number) { this.osc2.setFineTune(Math.max(-100, Math.min(100, val))); }

  setOsc1Level(val: number) { this.mixer.setChannelGain(1, Math.max(0, Math.min(1, val))); }
  setOsc2Level(val: number) { this.mixer.setChannelGain(2, Math.max(0, Math.min(1, val))); }

  setFilterCutoff(val: number) { this.baseCutoff = Math.max(20, Math.min(10000, val)); }
  setFilterEnvAmount(val: number) { this.filterEnvAmount = Math.max(0, Math.min(5000, val)); }

  setFilterRes(val: number) {
    const clamped = Math.max(0, Math.min(20, val));
    if (this.filter.inputs.resonance instanceof AudioParam) {
      this.filter.inputs.resonance.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
    }
  }

  setFilterEnv(env: { a: number; d: number; s: number; r: number }) {
    this.filterEnv.a = Math.max(0.001, env.a);
    this.filterEnv.d = Math.max(0.001, env.d);
    this.filterEnv.s = Math.max(0, Math.min(1, env.s));
    this.filterEnv.r = Math.max(0.001, env.r);
  }

  setAmpEnv(env: { a: number; d: number; s: number; r: number }) {
    this.ampEnv.a = Math.max(0.001, env.a);
    this.ampEnv.d = Math.max(0.001, env.d);
    this.ampEnv.s = Math.max(0, Math.min(1, env.s));
    this.ampEnv.r = Math.max(0.001, env.r);
  }

  // --- Polymorphic param application ---

  applyParams(params: Record<string, any>) {
    if (params.osc1Type !== undefined) this.setOsc1Type(params.osc1Type);
    if (params.osc2Type !== undefined) this.setOsc2Type(params.osc2Type);
    if (params.osc1Coarse !== undefined) this.setOsc1Coarse(params.osc1Coarse);
    if (params.osc1Fine !== undefined) this.setOsc1Fine(params.osc1Fine);
    if (params.osc2Coarse !== undefined) this.setOsc2Coarse(params.osc2Coarse);
    if (params.osc2Fine !== undefined) this.setOsc2Fine(params.osc2Fine);
    if (params.osc1Level !== undefined) this.setOsc1Level(params.osc1Level);
    if (params.osc2Level !== undefined) this.setOsc2Level(params.osc2Level);
    if (params.filterCutoff !== undefined) this.setFilterCutoff(params.filterCutoff);
    if (params.filterRes !== undefined) this.setFilterRes(params.filterRes);
    if (params.filterEnvAmount !== undefined) this.setFilterEnvAmount(params.filterEnvAmount);
    if (params.filterEnv !== undefined) this.setFilterEnv(params.filterEnv);
    if (params.ampEnv !== undefined) this.setAmpEnv(params.ampEnv);
  }

  trigger(freq: number, duration: number, time?: number) {
    if (this.ctx.state === 'suspended') {
        this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;

    // Frequency is now handled internally by OscillatorModule factoring in coarseTune
    this.osc1.setFrequencyAtTime(freq, scheduleTime);
    this.osc2.setFrequencyAtTime(freq, scheduleTime); 

    // Trigger Amplitude Envelope
    this.ampEnv.trigger(this.masterVCA.gain, scheduleTime, duration, 0, 1);

    // Trigger Filter Envelope (Modulating Cutoff)
    if (this.filter.inputs.cutoff instanceof AudioParam) {
        this.filterEnv.trigger(this.filter.inputs.cutoff, scheduleTime, duration, this.baseCutoff, this.baseCutoff + this.filterEnvAmount);
    }
  }

  dispose() {
    this.osc1.dispose();
    this.osc2.dispose();
    if (this.mixer.inputs.ch1 instanceof AudioNode) this.mixer.inputs.ch1.disconnect();
    if (this.mixer.inputs.ch2 instanceof AudioNode) this.mixer.inputs.ch2.disconnect();
    if (this.mixer.outputs.main instanceof AudioNode) this.mixer.outputs.main.disconnect();
    if (this.filter.inputs.main instanceof AudioNode) this.filter.inputs.main.disconnect();
    if (this.filter.outputs.main instanceof AudioNode) this.filter.outputs.main.disconnect();
    this.masterVCA.disconnect();
  }
}
