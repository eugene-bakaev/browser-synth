import { PatchBay } from './PatchBay';
import { OscillatorModule } from './modules/Oscillator';
import { MixerModule } from './modules/Mixer';
import { FilterModule } from './modules/Filter';
import { EnvelopeModule } from './modules/Envelope';
import { SoundEngine } from './types';

export class SynthEngine implements SoundEngine {
  ctx: AudioContext;
  private patchBay: PatchBay;
  
  osc1: OscillatorModule;
  osc2: OscillatorModule;
  mixer: MixerModule;
  filter: FilterModule;
  ampEnv: EnvelopeModule;
  filterEnv: EnvelopeModule;
  masterVCA: GainNode;

  baseCutoff: number = 2000;
  filterEnvAmount: number = 3000;

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
