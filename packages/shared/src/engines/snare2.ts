//
// snare2 — worklet snare-drum engine param table + defaults. Lives in
// @fiddle/shared so server-side validation and the project factory can
// construct/validate a default Project without touching DOM-only engine code.
//
// Synthesis model (Gordon Reid, SOS "Synth Secrets", snare-drum installments):
// two tuned shell oscillators (the drum's two lowest modes — a fundamental at
// `tune` and an enharmonic partial ~1.83× above it) crossfaded by `snappy`
// against a two-band noise path (a `tone`-brightened "body" band and a
// `noiseHp`-thinned "wires" band, each with its own decay). `bodyDecay` and
// `noiseDecay` set the two decay times. The kernel reads these from the
// Float32Array param block in descriptor order (see client
// engine/snare2/kernel/params.ts).

import { buildDrumDefaults, type DrumParamDescriptor } from './drum-descriptors.js';

// APPEND-ONLY (block index = array position; see drum-descriptors.ts).
export const SNARE2_DESCRIPTORS = [
  { key: 'tune',       min: 100,  max: 340,  default: 180,  label: 'Tune',   format: 'hz' },
  { key: 'bodyDecay',  min: 0.02, max: 0.4,  default: 0.1,  label: 'Body',   format: 'ms' },
  { key: 'noiseDecay', min: 0.02, max: 0.5,  default: 0.18, label: 'Snares', format: 'ms' },
  { key: 'snappy',     min: 0,    max: 1,    default: 0.6,  label: 'Snappy', format: 'percent' },
  { key: 'tone',       min: 800,  max: 8000, default: 3500, label: 'Tone',   format: 'hz' },
  { key: 'noiseHp',    min: 0,    max: 1,    default: 0.4,  label: 'HP',     format: 'percent' },
  { key: 'level',      min: 0,    max: 1,    default: 0.9,  label: 'Level',  format: 'percent' },
] as const satisfies readonly DrumParamDescriptor[];

export interface Snare2EngineParams {
  /** Shell fundamental pitch, Hz (a second partial is derived ~1.83× above it). */
  tune: number;
  /** Shell (tuned body) amplitude decay time, seconds. */
  bodyDecay: number;
  /** Noise (snares/wires) amplitude decay time, seconds. */
  noiseDecay: number;
  /** Shell ↔ noise balance — 0 = pure shell, 1 = pure noise (0..1). */
  snappy: number;
  /** Noise body-band brightness (lowpass cutoff), Hz. */
  tone: number;
  /** Highpass amount on the wires band — thins the snare buzz (0..1). */
  noiseHp: number;
  /** Output level (0..1). */
  level: number;
}

export const DEFAULT_SNARE2_PARAMS: Snare2EngineParams =
  buildDrumDefaults<Snare2EngineParams>(SNARE2_DESCRIPTORS);
