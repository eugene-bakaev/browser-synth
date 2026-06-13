//
// Synth2 param shape + defaults. Unlike synth1, the defaults are GENERATED
// from the descriptor table (spec §6.4) — the interface exists so TypeScript
// consumers get real field names, and the test asserts interface ↔ table
// agreement. Params are uniformly nested per module: descriptor key
// 'osc1.morph' ⇒ params.osc1.morph (spec §7).

import { SYNTH2_DESCRIPTORS } from './synth2-descriptors.js';

export interface Synth2OscParams {
  morph: number;       // 0 sine → 1 tri → 2 saw → 3 pulse (continuous)
  pulseWidth: number;
  coarse: number;      // semitones
  fine: number;        // cents
  level: number;
}

export interface Synth2EnvParams {
  a: number;
  d: number;
  s: number;
  r: number;
}

export interface Synth2EngineParams {
  osc1: Synth2OscParams;
  env1: Synth2EnvParams;
}

function buildDefaults(): Synth2EngineParams {
  const out: Record<string, Record<string, number>> = {};
  for (const d of SYNTH2_DESCRIPTORS) {
    const [mod, field] = d.key.split('.');
    (out[mod] ??= {})[field] = d.default;
  }
  return out as unknown as Synth2EngineParams;
}

export const DEFAULT_SYNTH2_PARAMS: Synth2EngineParams = buildDefaults();
