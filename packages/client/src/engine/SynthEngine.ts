import { SoundEngine } from './types';
import { SynthVoice } from './SynthVoice';
import { DEFAULT_SYNTH_PARAMS, type ADSR, type SynthEngineParams } from '@fiddle/shared';

// Re-export so existing client-side consumers `import { SynthEngineParams } from
// '../engine/SynthEngine'` keep working without churn.
export type { ADSR, SynthEngineParams } from '@fiddle/shared';

export class SynthEngine implements SoundEngine {
  readonly engineType = 'synth';
  readonly ctx: AudioContext;
  readonly voices: SynthVoice[] = [];
  private activeVoiceIndex = 0;
  private readonly numVoices = 6;
  private readonly masterVCA: GainNode;

  // Default param values now live in @fiddle/shared (DEFAULT_SYNTH_PARAMS) so
  // server-side code can read them too. Re-exported on the class for backward
  // compatibility with existing consumers (panels, presets, factory, tests).
  static readonly DEFAULT_PARAMS: SynthEngineParams = DEFAULT_SYNTH_PARAMS;

  // Parameter cache for voice initialization. Initialized from DEFAULT_SYNTH_PARAMS
  // so all the "what is the default synth sound" knowledge lives in one place.
  private osc1Type: OscillatorType = DEFAULT_SYNTH_PARAMS.osc1Type;
  private osc2Type: OscillatorType = DEFAULT_SYNTH_PARAMS.osc2Type;
  private osc1Coarse: number = DEFAULT_SYNTH_PARAMS.osc1Coarse;
  private osc1Fine: number = DEFAULT_SYNTH_PARAMS.osc1Fine;
  private osc2Coarse: number = DEFAULT_SYNTH_PARAMS.osc2Coarse;
  private osc2Fine: number = DEFAULT_SYNTH_PARAMS.osc2Fine;
  private osc1Level: number = DEFAULT_SYNTH_PARAMS.osc1Level;
  private osc2Level: number = DEFAULT_SYNTH_PARAMS.osc2Level;
  private osc1PulseWidth: number = DEFAULT_SYNTH_PARAMS.osc1PulseWidth;
  private osc2PulseWidth: number = DEFAULT_SYNTH_PARAMS.osc2PulseWidth;
  private baseCutoff: number = DEFAULT_SYNTH_PARAMS.filterCutoff;
  private filterEnvAmount: number = DEFAULT_SYNTH_PARAMS.filterEnvAmount;
  private filterRes: number = DEFAULT_SYNTH_PARAMS.filterRes;
  private filterEnv: ADSR = { ...DEFAULT_SYNTH_PARAMS.filterEnv };
  private ampEnv: ADSR = { ...DEFAULT_SYNTH_PARAMS.ampEnv };

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
        osc1PulseWidth: this.osc1PulseWidth,
        osc2PulseWidth: this.osc2PulseWidth,
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

  setOsc1PulseWidth(val: number) {
    this.osc1PulseWidth = Math.max(0.05, Math.min(0.95, val));
    this.voices.forEach(voice => voice.applyParams({ osc1PulseWidth: this.osc1PulseWidth }));
  }

  setOsc2PulseWidth(val: number) {
    this.osc2PulseWidth = Math.max(0.05, Math.min(0.95, val));
    this.voices.forEach(voice => voice.applyParams({ osc2PulseWidth: this.osc2PulseWidth }));
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
    if (params.osc1PulseWidth !== undefined) this.setOsc1PulseWidth(params.osc1PulseWidth);
    if (params.osc2PulseWidth !== undefined) this.setOsc2PulseWidth(params.osc2PulseWidth);
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

    // Mono path: a single freq always reuses voice[0]. Envelope.trigger calls
    // cancelAndHoldAtTime + a 1ms ramp to min on each retrigger, so the previous
    // note's tail is cleanly stolen instead of overlapping. Round-robining
    // across N voices in mono mode (the pre-fix behavior) left each prior voice
    // ringing out its full release, audible as overlapping tails.
    if (!Array.isArray(freq)) {
      this.voices[0].trigger(freq, duration, scheduleTime, velocity);
      // Next poly chord starts from voice[1] so it doesn't steal voice[0].
      this.activeVoiceIndex = 1 % this.numVoices;
      return;
    }

    // Poly: round-robin across voices, one per chord note.
    freq.forEach(f => {
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
