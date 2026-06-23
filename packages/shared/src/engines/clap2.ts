//
// clap2 — worklet hand-clap engine param table + defaults. Lives in @fiddle/shared
// so server-side validation and the project factory can construct/validate a default
// Project without touching DOM-only engine code.
//
// Synthesis model (Gordon Reid, SOS "Synth Secrets" + the classic TR-909 clap): a
// burst of `bursts` short noise transients spaced by `spread`, each decaying with
// `body`, summed with a longer reverberant `room` tail, balanced by `mix`, the whole
// source bandpass-shaped at `tone` (fixed Q). The kernel reads these from the
// Float32Array param block in descriptor order (see client engine/clap2/kernel/params.ts).

import { buildDrumDefaults, type DrumParamDescriptor } from './drum-descriptors.js';

// APPEND-ONLY (block index = array position; see drum-descriptors.ts).
export const CLAP2_DESCRIPTORS: readonly DrumParamDescriptor[] = [
  { key: 'tone',   min: 500,   max: 3000,  default: 1000,  label: 'Tone',   format: 'hz', curve: 'exp' },
  { key: 'spread', min: 0.005, max: 0.040, default: 0.012, label: 'Spread', format: 'ms', curve: 'exp' },
  { key: 'bursts', min: 2,     max: 5,     default: 3,     label: 'Bursts', step: 1,      curve: 'linear' },
  { key: 'body',   min: 0.002, max: 0.030, default: 0.008, label: 'Body',   format: 'ms', curve: 'exp' },
  { key: 'room',   min: 0.050, max: 0.800, default: 0.250, label: 'Room',   format: 'ms', curve: 'exp' },
  { key: 'mix',    min: 0,     max: 1,     default: 0.5,   label: 'Mix',    format: 'percent' },
  { key: 'level',  min: 0,     max: 1,     default: 0.8,   label: 'Level',  format: 'percent' },
] as const satisfies readonly DrumParamDescriptor[];

export interface Clap2EngineParams {
  /** Bandpass centre frequency, Hz (Q fixed). */
  tone: number;
  /** Spacing between the burst transients, seconds (tight ↔ loose). */
  spread: number;
  /** Number of transients in the burst (2..5, integer). */
  bursts: number;
  /** Per-transient decay time-constant, seconds. */
  body: number;
  /** Reverberant tail decay time-constant, seconds. */
  room: number;
  /** Burst-body ↔ room-tail balance (0..1). */
  mix: number;
  /** Output level (0..1). */
  level: number;
}

export const DEFAULT_CLAP2_PARAMS: Clap2EngineParams =
  buildDrumDefaults<Clap2EngineParams>(CLAP2_DESCRIPTORS);
