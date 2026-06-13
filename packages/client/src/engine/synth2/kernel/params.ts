//
// Float32Array param-block layout — GENERATED from the descriptor table:
// block[i] is the base value of SYNTH2_DESCRIPTORS[i] (spec §6.4/§6.7).
// Always address via PARAM_INDEX['osc1.morph'], never positional literals.

import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

export const PARAM_COUNT = SYNTH2_DESCRIPTORS.length;

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  SYNTH2_DESCRIPTORS.map((d, i) => [d.key, i]),
);

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(PARAM_COUNT);
  SYNTH2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  return block;
}
