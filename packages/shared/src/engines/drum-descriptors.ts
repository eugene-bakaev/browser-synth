//
// Shared param-descriptor shape for the worklet drum engines (kick2 / snare2 /
// hat2). Mirrors the synth2 "the descriptor table is the single source of truth"
// pattern, but lighter: drums have no mod matrix and no enum/bool params — every
// param is a continuous number. One descriptor table per engine drives:
//   - the TS params interface (hand-written; a contract test asserts agreement),
//   - DEFAULT_<ENGINE>_PARAMS (buildDrumDefaults below),
//   - the Zod leaf schema (schema.ts),
//   - the kernel's Float32Array param-block index layout (client kernel/params),
//   - panel knob ranges, labels, and display formats.
//
// APPEND-ONLY once an engine ships: the kernel block index is the array
// position, so inserting or reordering a row would silently scramble every older
// client's stored params (same ABI rule as the synth2 descriptor table).

import type { KnobCurve } from './knob-curve.js';

/** Knob display-format hint — a subset of the `format` prop values Knob.vue
 *  accepts (so a descriptor's format binds to <Knob :format> without a cast). */
export type DrumKnobFormat = 'hz' | 'ms' | 'percent' | 'db';

export interface DrumParamDescriptor {
  /** Field name — also the params object key and the wire-path tail under
   *  engines.<engine>.<key>. */
  key: string;
  min: number;
  max: number;
  default: number;
  /** Panel knob label. */
  label: string;
  /** Panel knob display format. Omitted ⇒ raw-number readout (Knob.vue renders
   *  val.toString()), used by integer count knobs like clap2's `bursts`. */
  format?: DrumKnobFormat;
  /** Optional linear drag-snap step. Omitted ⇒ the panel's default (max−min)/100.
   *  Only meaningful for LINEAR knobs — the exp/s drag path snaps in position
   *  space (roundSig) and ignores `step`. */
  step?: number;
  /** Optional UI knob response curve (presentational only). Omitted ⇒ 'linear'. */
  curve?: KnobCurve;
}

/** Build the flat default-params object from a descriptor table. The caller
 *  supplies the concrete params interface as T (which need not carry an index
 *  signature); a contract test asserts that the interface and the table carry
 *  exactly the same keys. */
export function buildDrumDefaults<T>(
  descriptors: readonly DrumParamDescriptor[],
): T {
  const out: Record<string, number> = {};
  for (const d of descriptors) out[d.key] = d.default;
  return out as T;
}
