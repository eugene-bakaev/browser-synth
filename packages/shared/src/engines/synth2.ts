//
// Synth2 param shape + defaults. Unlike synth1, the defaults are GENERATED
// from the descriptor table (spec §6.4) — the interface exists so TypeScript
// consumers get real field names, and the test asserts interface ↔ table
// agreement. Params are uniformly nested per module: descriptor key
// 'osc1.morph' ⇒ params.osc1.morph (spec §7).

import { SYNTH2_DESCRIPTORS, decodeBool, decodeEnum } from './synth2-descriptors.js';
import type { Synth2ModSource } from './synth2-descriptors.js';

export interface Synth2OscParams {
  morph: number;       // 0 sine → 1 tri → 2 saw → 3 pulse (continuous)
  pulseWidth: number;
  coarse: number;      // semitones
  fine: number;        // cents
  level: number;
  sync: boolean;       // hard-sync to the previous osc (inert on osc1 — master)
}

export interface Synth2EnvParams {
  a: number;
  d: number;
  s: number;
  r: number;
  loop: boolean; // I3c: cycle attack→decay→attack while gated (shared by env1/env2/env3)
}

export interface Synth2NoiseParams {
  level: number;
  color: number;
}

export interface Synth2FmParams {
  osc2: number; // osc1 → osc2 TZFM index
  osc3: number; // osc2 → osc3 TZFM index
}

export interface Synth2LfoParams {
  rate: number;   // Hz — free-mode rate; when sync is on the kernel receives a
                  // main-thread-derived Hz instead (this leaf is never overwritten)
  shape: number;  // 0..4 morph: sine → tri → saw-up → saw-down → square
  sync: boolean;  // tempo-sync on/off (rate derived from div × bpm on the main thread)
  div: string;    // note-division label from LFO_SYNC_DIVISIONS (used when sync is on)
}

export interface Synth2FilterParams {
  cutoff: number;     // Hz
  resonance: number;  // 0..1
  keyTrack: number;   // 0..1 — cutoff follows note pitch
  envAmount: number;  // bipolar octaves (±4): env2 → cutoff depth
  type: 'lp' | 'bp' | 'hp';
  morph: number;               // 0 LP → 1 BP → 2 HP (continuous MorphFilter blend)
  model: 'classic' | 'morph';  // which FilterModule the voice uses
  drive: number;               // 0..1 feedback saturation (self-osc character)
}

export interface Synth2MatrixSlot {
  source: Synth2ModSource;
  dest: string;   // 'none' | modulatable descriptor key (see MOD_DESTS)
  amount: number; // bipolar -1..1
}

export interface Synth2EngineParams {
  osc1: Synth2OscParams;
  osc2: Synth2OscParams;
  osc3: Synth2OscParams;
  noise: Synth2NoiseParams;
  fm: Synth2FmParams;
  lfo1: Synth2LfoParams;
  lfo2: Synth2LfoParams;
  env1: Synth2EnvParams;
  env2: Synth2EnvParams;
  env3: Synth2EnvParams; // I3c: third envelope — matrix source only, not hardwired
  filter: Synth2FilterParams;
  // Play mode — sequencer-level, like engines.synth.mode. Not a descriptor
  // (it's not a Float32Array param); lives here so presets carry their mode.
  mode: 'mono' | 'poly';
  // I3 mod matrix — fixed 8 slots (static wire shape, like the step buffer).
  matrix: Synth2MatrixSlot[];
}

/** Mod matrix is a fixed-size array (static wire shape). Single source of truth
 *  for the slot count — referenced by the schema, accept-list bound, defaults,
 *  and the kernel block layout. */
export const MATRIX_SLOT_COUNT = 8;

// Typed inert mod-matrix slot — all three fields are checked by the compiler,
// no cast needed. Spread into Array.from so each slot is an independent object.
const INERT_SLOT: Synth2MatrixSlot = { source: 'none', dest: 'none', amount: 0 };

function buildDefaults(): Synth2EngineParams {
  const out: Record<string, Record<string, number | boolean | string>> = {};
  for (const d of SYNTH2_DESCRIPTORS) {
    const [mod, field] = d.key.split('.');
    (out[mod] ??= {})[field] =
      d.kind === 'bool' ? decodeBool(d.default)
      : d.kind === 'enum' ? decodeEnum(d.default, d.enumValues!)
      : d.default;
  }
  return {
    ...(out as unknown as Synth2EngineParams),
    mode: 'mono',
    matrix: Array.from({ length: MATRIX_SLOT_COUNT }, () => ({ ...INERT_SLOT })),
  };
}

export const DEFAULT_SYNTH2_PARAMS: Synth2EngineParams = buildDefaults();
