import { SoundEngine } from './types';
import { SynthVoice } from './SynthVoice';

export interface ADSR {
  a: number;
  d: number;
  s: number;
  r: number;
}

export interface SynthEngineParams {
  osc1Type: OscillatorType;
  osc2Type: OscillatorType;
  osc1Coarse: number;
  osc1Fine: number;
  osc2Coarse: number;
  osc2Fine: number;
  osc1Level: number;
  osc2Level: number;
  filterCutoff: number;
  filterRes: number;
  filterEnvAmount: number;
  filterEnv: ADSR;
  ampEnv: ADSR;
  // Sequencer-level concern: read by useSynth's step trigger, not by SynthEngine
  // or SynthVoice. Lives here so engine presets carry their intended play mode.
  mode: 'mono' | 'poly';
}

export class SynthEngine implements SoundEngine {
  readonly engineType = 'synth';
  readonly ctx: AudioContext;
  readonly voices: SynthVoice[] = [];
  private activeVoiceIndex = 0;
  private readonly numVoices = 6;
  private readonly masterVCA: GainNode;

  // Single source of truth for what a "fresh" synth sounds like. Track defaults
  // in useSynth.ts spread this rather than redeclaring values inline.
  static readonly DEFAULT_PARAMS: SynthEngineParams = {
    osc1Type: 'sawtooth',
    osc2Type: 'sawtooth',
    osc1Coarse: 0,
    osc1Fine: 0,
    osc2Coarse: 0,
    osc2Fine: 0,
    osc1Level: 0.5,
    osc2Level: 0.5,
    filterCutoff: 2000,
    filterRes: 1,
    // In octaves (bipolar). See SynthVoice.FILTER_ENV_MAX_OCTAVES for range.
    filterEnvAmount: 2.4,
    filterEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
    ampEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
    mode: 'mono',
  };

  // Parameter cache for voice initialization. Initialized from DEFAULT_PARAMS
  // so all the "what is the default synth sound" knowledge lives in one place.
  private osc1Type: OscillatorType = SynthEngine.DEFAULT_PARAMS.osc1Type;
  private osc2Type: OscillatorType = SynthEngine.DEFAULT_PARAMS.osc2Type;
  private osc1Coarse: number = SynthEngine.DEFAULT_PARAMS.osc1Coarse;
  private osc1Fine: number = SynthEngine.DEFAULT_PARAMS.osc1Fine;
  private osc2Coarse: number = SynthEngine.DEFAULT_PARAMS.osc2Coarse;
  private osc2Fine: number = SynthEngine.DEFAULT_PARAMS.osc2Fine;
  private osc1Level: number = SynthEngine.DEFAULT_PARAMS.osc1Level;
  private osc2Level: number = SynthEngine.DEFAULT_PARAMS.osc2Level;
  private baseCutoff: number = SynthEngine.DEFAULT_PARAMS.filterCutoff;
  private filterEnvAmount: number = SynthEngine.DEFAULT_PARAMS.filterEnvAmount;
  private filterRes: number = SynthEngine.DEFAULT_PARAMS.filterRes;
  private filterEnv: ADSR = { ...SynthEngine.DEFAULT_PARAMS.filterEnv };
  private ampEnv: ADSR = { ...SynthEngine.DEFAULT_PARAMS.ampEnv };

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

  setFilterEnvAmount(val: number) {
    const max = SynthVoice.FILTER_ENV_MAX_OCTAVES;
    this.filterEnvAmount = Math.max(-max, Math.min(max, val));
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
