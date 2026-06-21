//
// Float32Array param-block layout for hat2 — GENERATED from the shared descriptor
// table: block[i] is the base value of HAT2_DESCRIPTORS[i]. Always address via
// PARAM_INDEX['tone'], never positional literals (append-only ABI). Mirrors
// snare2/kernel/params.ts.

import { HAT2_DESCRIPTORS } from '@fiddle/shared';

export const PARAM_COUNT = HAT2_DESCRIPTORS.length;

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  HAT2_DESCRIPTORS.map((d, i) => [d.key, i]),
);

export const BLOCK_LENGTH = PARAM_COUNT;

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(BLOCK_LENGTH);
  HAT2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  return block;
}
