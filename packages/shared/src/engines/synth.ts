// Synth engine param shape and default. Lives in @fiddle/shared so server-side
// code can construct/validate a default Project without importing any DOM /
// Web Audio types. The client SynthEngine class imports these back.

// `OscillatorType` is a DOM lib type; inlined here as a literal union so this
// module compiles in a Node-only TS project (server) without the DOM lib.
export type OscillatorTypeLiteral = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface ADSR {
  a: number;
  d: number;
  s: number;
  r: number;
}

export interface SynthEngineParams {
  osc1Type: OscillatorTypeLiteral;
  osc2Type: OscillatorTypeLiteral;
  osc1Coarse: number;
  osc1Fine: number;
  osc2Coarse: number;
  osc2Fine: number;
  osc1Level: number;
  osc2Level: number;
  // Duty cycle for the pulse worklet oscillator. Only audible when the
  // matching oscNType === 'square'; the worklet provides a PolyBLEP-corrected
  // pulse that band-limits cleanly across the keyboard. 0.5 = symmetric square.
  osc1PulseWidth: number;
  osc2PulseWidth: number;
  filterCutoff: number;
  filterRes: number;
  filterEnvAmount: number;
  filterEnv: ADSR;
  ampEnv: ADSR;
  // Sequencer-level concern: read by useSynth's step trigger, not by SynthEngine
  // or SynthVoice. Lives here so engine presets carry their intended play mode.
  mode: 'mono' | 'poly';
}

// Single source of truth for what a "fresh" synth sounds like. Track defaults
// in useSynth.ts spread this rather than redeclaring values inline.
export const DEFAULT_SYNTH_PARAMS: SynthEngineParams = {
  osc1Type: 'sawtooth',
  osc2Type: 'sawtooth',
  osc1Coarse: 0,
  osc1Fine: 0,
  osc2Coarse: 0,
  osc2Fine: 0,
  osc1Level: 0.5,
  osc2Level: 0.5,
  osc1PulseWidth: 0.5,
  osc2PulseWidth: 0.5,
  filterCutoff: 2000,
  filterRes: 1,
  // In octaves (bipolar). See SynthVoice.FILTER_ENV_MAX_OCTAVES for range.
  filterEnvAmount: 2.4,
  filterEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
  ampEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
  mode: 'mono',
};
