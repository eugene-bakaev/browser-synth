//
// Float32Array param-block layout — GENERATED from the descriptor table:
// block[i] is the base value of SYNTH2_DESCRIPTORS[i] (spec §6.4/§6.7).
// Always address via PARAM_INDEX['osc1.morph'], never positional literals.

import { SYNTH2_DESCRIPTORS, MATRIX_SLOT_COUNT } from '@fiddle/shared';

export const PARAM_COUNT = SYNTH2_DESCRIPTORS.length;

export const PARAM_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  SYNTH2_DESCRIPTORS.map((d, i) => [d.key, i]),
);

// I3 mod matrix rides the SAME param block, appended after the descriptor
// params (preserving the descriptor block's append-only ABI). 8 slots × 3
// floats: [sourceIndex, destEncoded, amount]. destEncoded = 0 means "none";
// otherwise it is PARAM_INDEX(destKey)+1, so the dest encoding is append-stable
// for the same reason the descriptor block is.
export const MATRIX_SLOTS = MATRIX_SLOT_COUNT; // single-sourced from @fiddle/shared
export const MATRIX_STRIDE = 3; // source, dest, amount
export const MATRIX_BASE = PARAM_COUNT;
export const BLOCK_LENGTH = PARAM_COUNT + MATRIX_SLOTS * MATRIX_STRIDE;

export function defaultParamBlock(): Float32Array {
  const block = new Float32Array(BLOCK_LENGTH);
  SYNTH2_DESCRIPTORS.forEach((d, i) => { block[i] = d.default; });
  // Matrix region stays all-zero ⇒ every route inert. The disable sentinel is
  // destEncoded=0 (decodes to destSlot=-1, skipped); source index 0 is just
  // MOD_SOURCES[0]='none' whose per-sample value is always 0, and amount=0.
  return block;
}
