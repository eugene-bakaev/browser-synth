//
// Float32Array param-block layout for clap2 — GENERATED from the shared descriptor
// table: block[i] is the base value of CLAP2_DESCRIPTORS[i]. Always address via
// PARAM_INDEX['tone'], never positional literals (append-only ABI). Mirrors
// hat2/kernel/params.ts.

import { CLAP2_DESCRIPTORS } from '@fiddle/shared';

export const PARAM_COUNT = CLAP2_DESCRIPTORS.length;

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  CLAP2_DESCRIPTORS.map((d, i) => [d.key, i]),
);

export const BLOCK_LENGTH = PARAM_COUNT;

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(BLOCK_LENGTH);
  CLAP2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  return block;
}
