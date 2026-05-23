import { SoundEngine } from './types';
import { SynthVoice } from './SynthVoice';

export class SynthEngine implements SoundEngine {
  readonly engineType = 'synth';
  readonly ctx: AudioContext;
  readonly voices: SynthVoice[] = [];
  private activeVoiceIndex = 0;
  private readonly numVoices = 6;
  private readonly masterVCA: GainNode;

  // Parameter Cache for Voice Initialization and Verification
  private osc1Type: OscillatorType = 'sawtooth';
  private osc2Type: OscillatorType = 'sawtooth';
  private osc1Coarse: number = 0;
  private osc1Fine: number = 0;
  private osc2Coarse: number = 0;
  private osc2Fine: number = 0;
  private osc1Level: number = 0.5;
  private osc2Level: number = 0.5;
  private baseCutoff: number = 2000;
  private filterEnvAmount: number = 0.6;
  private useHzOffsetMode: boolean = false;
  private filterRes: number = 1;
  private filterEnv = { a: 0.01, d: 0.2, s: 0.5, r: 0.5 };
  private ampEnv = { a: 0.01, d: 0.2, s: 0.5, r: 0.5 };

  constructor(sharedCtx?: AudioContext, destination?: AudioNode) {
    this.ctx = sharedCtx ?? new AudioContext();
    this.masterVCA = this.ctx.createGain();
    this.masterVCA.gain.value = 1.0;
    this.masterVCA.connect(destination ?? this.ctx.destination);

    for (let i = 0; i < this.numVoices; i++) {
      const voice = new SynthVoice(this.ctx, this.masterVCA);
      // Initialize the voice with our default parameters
      voice.applyParams({
        osc1Type: this.osc1Type,
        osc2Type: this.osc2Type,
        osc1Coarse: this.osc1Coarse,
        osc1Fine: this.osc1Fine,
        osc2Coarse: this.osc2Coarse,
        osc2Fine: this.osc2Fine,
        osc1Level: this.osc1Level,
        osc2Level: this.osc2Level,
        filterRes: this.filterRes,
        useHzOffsetMode: this.useHzOffsetMode,
        filterCutoff: this.baseCutoff,
        filterEnvAmount: this.filterEnvAmount,
        filterEnv: this.filterEnv,
        ampEnv: this.ampEnv,
      });
      this.voices.push(voice);
    }
  }

  // --- Setter methods (encapsulated API, delegates to voices) ---

  setOsc1Type(type: OscillatorType) {
    this.osc1Type = type;
    this.voices.forEach(voice => voice.applyParams({ osc1Type: type }));
  }

  setOsc2Type(type: OscillatorType) {
    this.osc2Type = type;
    this.voices.forEach(voice => voice.applyParams({ osc2Type: type }));
  }

  setOsc1Coarse(val: number) {
    this.osc1Coarse = Math.max(-3, Math.min(3, val));
    this.voices.forEach(voice => voice.applyParams({ osc1Coarse: this.osc1Coarse }));
  }

  setOsc1Fine(val: number) {
    this.osc1Fine = Math.max(-100, Math.min(100, val));
    this.voices.forEach(voice => voice.applyParams({ osc1Fine: this.osc1Fine }));
  }

  setOsc2Coarse(val: number) {
    this.osc2Coarse = Math.max(-3, Math.min(3, val));
    this.voices.forEach(voice => voice.applyParams({ osc2Coarse: this.osc2Coarse }));
  }

  setOsc2Fine(val: number) {
    this.osc2Fine = Math.max(-100, Math.min(100, val));
    this.voices.forEach(voice => voice.applyParams({ osc2Fine: this.osc2Fine }));
  }

  setOsc1Level(val: number) {
    this.osc1Level = Math.max(0, Math.min(1, val));
    this.voices.forEach(voice => voice.applyParams({ osc1Level: this.osc1Level }));
  }

  setOsc2Level(val: number) {
    this.osc2Level = Math.max(0, Math.min(1, val));
    this.voices.forEach(voice => voice.applyParams({ osc2Level: this.osc2Level }));
  }

  setFilterCutoff(val: number) {
    this.baseCutoff = Math.max(20, Math.min(20000, val));
    this.voices.forEach(voice => voice.applyParams({ filterCutoff: this.baseCutoff }));
  }

  setUseHzOffsetMode(enabled: boolean) {
    this.useHzOffsetMode = enabled;
    // Set HzOffsetMode on voices first, so filterEnvAmount clamps correctly on them
    this.voices.forEach(voice => voice.applyParams({ useHzOffsetMode: this.useHzOffsetMode }));
  }

  setFilterEnvAmount(val: number) {
    if (this.useHzOffsetMode) {
      this.filterEnvAmount = Math.max(0, Math.min(5000, val));
    } else {
      this.filterEnvAmount = Math.max(0, Math.min(1, val));
    }
    this.voices.forEach(voice => voice.applyParams({ filterEnvAmount: this.filterEnvAmount }));
  }

  setFilterRes(val: number) {
    this.filterRes = Math.max(0, Math.min(20, val));
    this.voices.forEach(voice => voice.applyParams({ filterRes: this.filterRes }));
  }

  setFilterEnv(env: { a: number; d: number; s: number; r: number }) {
    this.filterEnv = {
      a: Math.max(0.001, env.a),
      d: Math.max(0.001, env.d),
      s: Math.max(0, Math.min(1, env.s)),
      r: Math.max(0.001, env.r),
    };
    this.voices.forEach(voice => voice.applyParams({ filterEnv: this.filterEnv }));
  }

  setAmpEnv(env: { a: number; d: number; s: number; r: number }) {
    this.ampEnv = {
      a: Math.max(0.001, env.a),
      d: Math.max(0.001, env.d),
      s: Math.max(0, Math.min(1, env.s)),
      r: Math.max(0.001, env.r),
    };
    this.voices.forEach(voice => voice.applyParams({ ampEnv: this.ampEnv }));
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
    if (params.filterRes !== undefined) this.setFilterRes(params.filterRes);
    if (params.useHzOffsetMode !== undefined) this.setUseHzOffsetMode(params.useHzOffsetMode);
    if (params.filterCutoff !== undefined) this.setFilterCutoff(params.filterCutoff);
    if (params.filterEnvAmount !== undefined) this.setFilterEnvAmount(params.filterEnvAmount);
    if (params.filterEnv !== undefined) this.setFilterEnv(params.filterEnv);
    if (params.ampEnv !== undefined) this.setAmpEnv(params.ampEnv);
  }

  trigger(freq: number | number[], duration: number, time?: number, velocity: number = 1.0) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;
    const freqs = Array.isArray(freq) ? freq : [freq];

    freqs.forEach(f => {
      const voice = this.voices[this.activeVoiceIndex];
      voice.trigger(f, duration, scheduleTime, velocity);
      this.activeVoiceIndex = (this.activeVoiceIndex + 1) % this.numVoices;
    });
  }

  dispose() {
    this.voices.forEach(voice => voice.dispose());
    this.masterVCA.disconnect();
  }
}
