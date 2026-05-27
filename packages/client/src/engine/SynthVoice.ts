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
  // Bipolar filter envelope amount, in OCTAVES from baseCutoff.
  // +4 = sweep four octaves up; -4 = sweep four octaves down; 0 = no sweep.
  // Logarithmic so the perceived sweep depth is consistent across all base cutoffs.
  static readonly FILTER_ENV_MAX_OCTAVES = 4;
  filterEnvAmount: number = 2.4;

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

    // Initialize the filter cutoff to baseCutoff so it isn't sitting at the
    // BiquadFilterNode default (~350Hz) until the first trigger.
    if (this.filter.inputs.cutoff instanceof AudioParam) {
      this.filter.inputs.cutoff.setValueAtTime(this.baseCutoff, ctx.currentTime);
    }

    // Route: osc1 & osc2 -> mixer -> filter -> voiceGain -> destination
    this.patchBay.connect(this.osc1.outputs.main, this.mixer.inputs.ch1);
    this.patchBay.connect(this.osc2.outputs.main, this.mixer.inputs.ch2);
    this.patchBay.connect(this.mixer.outputs.main, this.filter.inputs.main);
    this.patchBay.connect(this.filter.outputs.main, this.voiceGain);
    this.voiceGain.connect(destination);
  }

  trigger(freq: number, duration: number, time: number, velocity: number = 1.0) {
    // Set oscillator frequencies at targeted time
    this.osc1.setFrequencyAtTime(freq, time);
    this.osc2.setFrequencyAtTime(freq, time);

    // Trigger Amplitude Envelope on the local voice VCA, scaled by velocity
    const v = Math.max(0, Math.min(1, velocity));
    this.ampEnv.trigger(this.voiceGain.gain, time, duration, 0, v);

    // Trigger Filter Envelope (modulates cutoff up OR down by N octaves)
    if (this.filter.inputs.cutoff instanceof AudioParam) {
      // Log scale: same perceived sweep depth regardless of base cutoff.
      // Clamp peak to the audible range so we don't waste sweep above Nyquist
      // or below the BiquadFilter's effective floor.
      const peakCutoff = Math.max(20, Math.min(20000,
        this.baseCutoff * Math.pow(2, this.filterEnvAmount)
      ));
      this.filterEnv.trigger(
        this.filter.inputs.cutoff,
        time,
        duration,
        this.baseCutoff,
        peakCutoff
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

    if (params.osc1PulseWidth !== undefined) this.osc1.setPulseWidth(params.osc1PulseWidth);
    if (params.osc2PulseWidth !== undefined) this.osc2.setPulseWidth(params.osc2PulseWidth);
    
    if (params.filterRes !== undefined) {
      const clamped = Math.max(0, Math.min(20, params.filterRes));
      if (this.filter.inputs.resonance instanceof AudioParam) {
        this.filter.inputs.resonance.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
      }
    }

    if (params.filterCutoff !== undefined) {
      this.baseCutoff = Math.max(20, Math.min(20000, params.filterCutoff));
      // Write the live AudioParam so the cutoff knob affects sustaining notes
      // immediately, not only on next trigger. Active filter envelopes call
      // cancelAndHold + linearRamp on each trigger, which preempts any
      // setTargetAtTime in flight — so this never fights an active envelope.
      if (this.filter.inputs.cutoff instanceof AudioParam) {
        this.filter.inputs.cutoff.setTargetAtTime(this.baseCutoff, this.ctx.currentTime, 0.01);
      }
    }

    if (params.filterEnvAmount !== undefined) {
      const max = SynthVoice.FILTER_ENV_MAX_OCTAVES;
      this.filterEnvAmount = Math.max(-max, Math.min(max, params.filterEnvAmount));
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
