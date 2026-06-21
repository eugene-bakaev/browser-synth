//
// Float32Array param-block layout for kick2 — GENERATED from the shared
// descriptor table: block[i] is the base value of KICK2_DESCRIPTORS[i]. Always
// address via PARAM_INDEX['tune'], never positional literals (the table is
// append-only; positions are an ABI). Mirrors synth2/kernel/params.ts but
// flatter — drums have no mod matrix.

import { KICK2_DESCRIPTORS } from '@fiddle/shared';

export const PARAM_COUNT = KICK2_DESCRIPTORS.length;

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  KICK2_DESCRIPTORS.map((d, i) => [d.key, i]),
);

export const BLOCK_LENGTH = PARAM_COUNT;

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(BLOCK_LENGTH);
  KICK2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  return block;
}
