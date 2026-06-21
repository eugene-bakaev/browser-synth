//
// hat2 — worklet hi-hat engine param table + defaults. Lives in @fiddle/shared so
// server-side validation and the project factory can construct/validate a default
// Project without touching DOM-only engine code.
//
// Synthesis model (Gordon Reid, SOS "Synth Secrets", metallic-percussion): six
// enharmonic square oscillators (the documented TR-808 cluster, reused from the
// analog HatEngine) crossfaded by `metallic` against white noise, with a `ring`
// ring-mod between two cluster members for extra clang, then band-shaped by a
// highpass (`hpf`) and a top-tilt lowpass (`tone`) and an AD envelope (`decay` sets
// closed↔open length). The kernel reads these from the Float32Array param block in
// descriptor order (see client engine/hat2/kernel/params.ts).

import { buildDrumDefaults, type DrumParamDescriptor } from './drum-descriptors.js';

// APPEND-ONLY (block index = array position; see drum-descriptors.ts).
export const HAT2_DESCRIPTORS = [
  { key: 'tone',     min: 3000, max: 14000, default: 9000, label: 'Tone',  format: 'hz' },
  { key: 'decay',    min: 0.02, max: 0.8,   default: 0.08, label: 'Decay', format: 'ms' },
  { key: 'hpf',      min: 3000, max: 12000, default: 7000, label: 'HPF',   format: 'hz' },
  { key: 'metallic', min: 0,    max: 1,     default: 0.7,  label: 'Metal', format: 'percent' },
  { key: 'ring',     min: 0,    max: 1,     default: 0.2,  label: 'Ring',  format: 'percent' },
  { key: 'level',    min: 0,    max: 1,     default: 0.8,  label: 'Level', format: 'percent' },
] as const satisfies readonly DrumParamDescriptor[];

export interface Hat2EngineParams {
  /** Top-tilt lowpass cutoff that shapes the band brightness, Hz. */
  tone: number;
  /** Amplitude decay time, seconds (closed ↔ open hat). */
  decay: number;
  /** Highpass cutoff applied to the source, Hz. */
  hpf: number;
  /** Square-cluster ↔ white-noise balance — 1 = pure metal, 0 = pure noise (0..1). */
  metallic: number;
  /** Ring-mod amount between two cluster members — adds clang (0..1). */
  ring: number;
  /** Output level (0..1). */
  level: number;
}

export const DEFAULT_HAT2_PARAMS: Hat2EngineParams =
  buildDrumDefaults<Hat2EngineParams>(HAT2_DESCRIPTORS);
