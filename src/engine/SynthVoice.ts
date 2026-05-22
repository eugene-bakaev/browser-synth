import { PatchBay } from './PatchBay';
import { OscillatorModule } from './modules/Oscillator';
import { MixerModule } from './modules/Mixer';
import { FilterModule } from './modules/Filter';
import { EnvelopeModule } from './modules/Envelope';

export class SynthVoice {
  readonly ctx: AudioContext;
  private patchBay: PatchBay;
  
  osc1: OscillatorModule;
  osc2: OscillatorModule;
  mixer: MixerModule;
  filter: FilterModule;
  ampEnv: EnvelopeModule;
  filterEnv: EnvelopeModule;
  voiceGain: GainNode;

  baseCutoff: number = 2000;
  filterEnvAmount: number = 0.6;
  useHzOffsetMode: boolean = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.patchBay = new PatchBay();
    
    this.osc1 = new OscillatorModule(ctx);
    this.osc2 = new OscillatorModule(ctx);
    this.mixer = new MixerModule(ctx);
    this.filter = new FilterModule(ctx);
    this.ampEnv = new EnvelopeModule();
    this.filterEnv = new EnvelopeModule();
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;

    // Route: osc1 & osc2 -> mixer -> filter -> voiceGain -> destination
    this.patchBay.connect(this.osc1.outputs.main, this.mixer.inputs.ch1);
    this.patchBay.connect(this.osc2.outputs.main, this.mixer.inputs.ch2);
    this.patchBay.connect(this.mixer.outputs.main, this.filter.inputs.main);
    this.patchBay.connect(this.filter.outputs.main, this.voiceGain);
    this.voiceGain.connect(destination);
  }

  trigger(freq: number, duration: number, time: number) {
    // Set oscillator frequencies at targeted time
    this.osc1.setFrequencyAtTime(freq, time);
    this.osc2.setFrequencyAtTime(freq, time); 

    // Trigger Amplitude Envelope on the local voice VCA
    this.ampEnv.trigger(this.voiceGain.gain, time, duration, 0, 1);

    // Trigger Filter Envelope (Modulating Cutoff)
    if (this.filter.inputs.cutoff instanceof AudioParam) {
      const sweepRange = this.useHzOffsetMode 
        ? this.filterEnvAmount 
        : (this.filterEnvAmount * 5000);
      this.filterEnv.trigger(
        this.filter.inputs.cutoff, 
        time, 
        duration, 
        this.baseCutoff, 
        this.baseCutoff + sweepRange
      );
    }
  }

  applyParams(params: Record<string, any>) {
    if (params.osc1Type !== undefined) this.osc1.setWaveform(params.osc1Type);
    if (params.osc2Type !== undefined) this.osc2.setWaveform(params.osc2Type);
    
    if (params.osc1Coarse !== undefined) this.osc1.setCoarseTune(params.osc1Coarse);
    if (params.osc1Fine !== undefined) this.osc1.setFineTune(params.osc1Fine);
    if (params.osc2Coarse !== undefined) this.osc2.setCoarseTune(params.osc2Coarse);
    if (params.osc2Fine !== undefined) this.osc2.setFineTune(params.osc2Fine);
    
    if (params.osc1Level !== undefined) this.mixer.setChannelGain(1, params.osc1Level);
    if (params.osc2Level !== undefined) this.mixer.setChannelGain(2, params.osc2Level);
    
    if (params.filterRes !== undefined) {
      const clamped = Math.max(0, Math.min(20, params.filterRes));
      if (this.filter.inputs.resonance instanceof AudioParam) {
        this.filter.inputs.resonance.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
      }
    }

    if (params.useHzOffsetMode !== undefined) {
      this.useHzOffsetMode = params.useHzOffsetMode;
    }
    
    if (params.filterCutoff !== undefined) {
      this.baseCutoff = Math.max(20, Math.min(20000, params.filterCutoff));
    }
    
    if (params.filterEnvAmount !== undefined) {
      if (this.useHzOffsetMode) {
        this.filterEnvAmount = Math.max(0, Math.min(5000, params.filterEnvAmount));
      } else {
        this.filterEnvAmount = Math.max(0, Math.min(1, params.filterEnvAmount));
      }
    }

    if (params.filterEnv !== undefined) {
      this.filterEnv.a = Math.max(0.001, params.filterEnv.a);
      this.filterEnv.d = Math.max(0.001, params.filterEnv.d);
      this.filterEnv.s = Math.max(0, Math.min(1, params.filterEnv.s));
      this.filterEnv.r = Math.max(0.001, params.filterEnv.r);
    }

    if (params.ampEnv !== undefined) {
      this.ampEnv.a = Math.max(0.001, params.ampEnv.a);
      this.ampEnv.d = Math.max(0.001, params.ampEnv.d);
      this.ampEnv.s = Math.max(0, Math.min(1, params.ampEnv.s));
      this.ampEnv.r = Math.max(0.001, params.ampEnv.r);
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
    this.voiceGain.disconnect();
  }
}
