//
// Synth2 param shape + defaults. Unlike synth1, the defaults are GENERATED
// from the descriptor table (spec §6.4) — the interface exists so TypeScript
// consumers get real field names, and the test asserts interface ↔ table
// agreement. Params are uniformly nested per module: descriptor key
// 'osc1.morph' ⇒ params.osc1.morph (spec §7).

import { SYNTH2_DESCRIPTORS, decodeBool } from './synth2-descriptors.js';

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
}

export interface Synth2NoiseParams {
  level: number;
  color: number;
}

export interface Synth2FmParams {
  osc2: number; // osc1 → osc2 TZFM index
  osc3: number; // osc2 → osc3 TZFM index
}

export interface Synth2EngineParams {
  osc1: Synth2OscParams;
  osc2: Synth2OscParams;
  osc3: Synth2OscParams;
  noise: Synth2NoiseParams;
  fm: Synth2FmParams;
  env1: Synth2EnvParams;
  // Play mode — sequencer-level, like engines.synth.mode. Not a descriptor
  // (it's not a Float32Array param); lives here so presets carry their mode.
  mode: 'mono' | 'poly';
}

function buildDefaults(): Synth2EngineParams {
  const out: Record<string, Record<string, number | boolean>> = {};
  for (const d of SYNTH2_DESCRIPTORS) {
    const [mod, field] = d.key.split('.');
    (out[mod] ??= {})[field] = d.kind === 'bool' ? decodeBool(d.default) : d.default;
  }
  return { ...(out as unknown as Synth2EngineParams), mode: 'mono' };
}

export const DEFAULT_SYNTH2_PARAMS: Synth2EngineParams = buildDefaults();
