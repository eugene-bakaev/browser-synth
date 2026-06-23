// Client-writable path accept-list + per-path value validator.
//
// The sync protocol restricts which Project paths a client can mutate. This
// module owns:
//
//   1. PATTERNS — the canonical accept-list of writable paths, using `*` as a
//      wildcard for numeric indices.
//   2. pathIsWritable(path) — pattern match against PATTERNS.
//   3. resolveLeafSchema(path) — finds the Zod schema for the leaf at `path`.
//   4. validatePathAndValue(path, value) — combines (2) and (3) and returns a
//      structured result the server can turn into `op.nack` reasons.
//
// Bounds note: pathIsWritable only checks the path *shape*, not whether the
// numeric indices are in range. A path like `tracks.99.engineType` will pass
// because the pattern allows `tracks.*.engineType`. The server-side
// ConnectionHandler is responsible for additionally bounds-checking
// track indices (0..TRACK_POOL_SIZE-1) and step indices (0..63) before
// applying the op.

import { z } from 'zod';
import { TRACK_POOL_SIZE } from './constants.js';
import { Schemas, SYNTH2_LEAF_SCHEMAS } from './schema.js';
import { SYNTH2_DESCRIPTORS } from '../engines/synth2-descriptors.js';
import { MATRIX_SLOT_COUNT } from '../engines/synth2.js';
import { KICK2_DESCRIPTORS } from '../engines/kick2.js';
import { SNARE2_DESCRIPTORS } from '../engines/snare2.js';
import { HAT2_DESCRIPTORS } from '../engines/hat2.js';
import { CLAP2_DESCRIPTORS } from '../engines/clap2.js';

// Order matters only for human reading; lookups iterate the full list.
export const PATTERNS: ReadonlyArray<ReadonlyArray<string>> = [
  ['bpm'],
  ['tracks', '*', 'engineType'],
  ['tracks', '*', 'patternLength'],
  ['tracks', '*', 'enabled'],
  // Synth params (leaves only — no whole-object writes).
  ['tracks', '*', 'engines', 'synth', 'osc1Type'],
  ['tracks', '*', 'engines', 'synth', 'osc2Type'],
  ['tracks', '*', 'engines', 'synth', 'osc1Coarse'],
  ['tracks', '*', 'engines', 'synth', 'osc2Coarse'],
  ['tracks', '*', 'engines', 'synth', 'osc1Fine'],
  ['tracks', '*', 'engines', 'synth', 'osc2Fine'],
  ['tracks', '*', 'engines', 'synth', 'osc1Level'],
  ['tracks', '*', 'engines', 'synth', 'osc2Level'],
  ['tracks', '*', 'engines', 'synth', 'osc1PulseWidth'],
  ['tracks', '*', 'engines', 'synth', 'osc2PulseWidth'],
  ['tracks', '*', 'engines', 'synth', 'filterCutoff'],
  ['tracks', '*', 'engines', 'synth', 'filterRes'],
  ['tracks', '*', 'engines', 'synth', 'filterEnvAmount'],
  ['tracks', '*', 'engines', 'synth', 'filterEnv', 'a'],
  ['tracks', '*', 'engines', 'synth', 'filterEnv', 'd'],
  ['tracks', '*', 'engines', 'synth', 'filterEnv', 's'],
  ['tracks', '*', 'engines', 'synth', 'filterEnv', 'r'],
  ['tracks', '*', 'engines', 'synth', 'ampEnv', 'a'],
  ['tracks', '*', 'engines', 'synth', 'ampEnv', 'd'],
  ['tracks', '*', 'engines', 'synth', 'ampEnv', 's'],
  ['tracks', '*', 'engines', 'synth', 'ampEnv', 'r'],
  ['tracks', '*', 'engines', 'synth', 'mode'],
  // Kick params.
  ['tracks', '*', 'engines', 'kick', 'tune'],
  ['tracks', '*', 'engines', 'kick', 'decay'],
  ['tracks', '*', 'engines', 'kick', 'click'],
  // Hat params.
  ['tracks', '*', 'engines', 'hat', 'decay'],
  ['tracks', '*', 'engines', 'hat', 'tone'],
  ['tracks', '*', 'engines', 'hat', 'metallic'],
  // Snare params.
  ['tracks', '*', 'engines', 'snare', 'tune'],
  ['tracks', '*', 'engines', 'snare', 'decay'],
  ['tracks', '*', 'engines', 'snare', 'snappy'],
  // Clap params.
  ['tracks', '*', 'engines', 'clap', 'decay'],
  ['tracks', '*', 'engines', 'clap', 'tone'],
  ['tracks', '*', 'engines', 'clap', 'sloppy'],
  // kick2 params — GENERATED from the descriptor table: one flat leaf pattern
  // per row, nested as engines.kick2.<field> (length-5 paths, like the other
  // drums).
  ...KICK2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'kick2', d.key]),
  // snare2 params — GENERATED from the descriptor table (same as kick2).
  ...SNARE2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'snare2', d.key]),
  // hat2 params — GENERATED from the descriptor table (same as kick2/snare2).
  ...HAT2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'hat2', d.key]),
  // clap2 params — GENERATED from the descriptor table (same as kick2/snare2/hat2).
  ...CLAP2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'clap2', d.key]),
  // Synth2 params — GENERATED from the descriptor table (spec §6.4): one
  // leaf pattern per descriptor, nested as engines.synth2.<module>.<field>.
  ...SYNTH2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'synth2', ...d.key.split('.')]),
  // synth2 play mode — not a descriptor, sibling of the modules (like synth.mode).
  ['tracks', '*', 'engines', 'synth2', 'mode'],
  // synth2 mod matrix — 8 fixed slots, leaves only (no whole-slot writes).
  ['tracks', '*', 'engines', 'synth2', 'matrix', '*', 'source'],
  ['tracks', '*', 'engines', 'synth2', 'matrix', '*', 'dest'],
  ['tracks', '*', 'engines', 'synth2', 'matrix', '*', 'amount'],
  // Mixer.
  ['tracks', '*', 'mixer', 'volume'],
  ['tracks', '*', 'mixer', 'muted'],
  ['tracks', '*', 'mixer', 'soloed'],
  // Steps.
  ['tracks', '*', 'steps', '*', 'note'],
  ['tracks', '*', 'steps', '*', 'octave'],
  ['tracks', '*', 'steps', '*', 'length'],
  ['tracks', '*', 'steps', '*', 'velocity'],
  ['tracks', '*', 'steps', '*', 'muted'],
  ['tracks', '*', 'steps', '*', 'isChord'],
  ['tracks', '*', 'steps', '*', 'chordType'],
];

function tokenize(path: string): string[] {
  // Empty path is invalid by construction (no top-level scalar replace).
  return path.split('.');
}

function matchesPattern(
  tokens: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
): boolean {
  if (tokens.length !== pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const pat = pattern[i];
    const tok = tokens[i];
    if (pat === '*') {
      // Wildcard: must be a non-negative integer (array index).
      if (!/^\d+$/.test(tok)) return false;
    } else if (pat !== tok) {
      return false;
    }
  }
  return true;
}

export function pathIsWritable(path: string): boolean {
  const tokens = tokenize(path);
  return PATTERNS.some(p => matchesPattern(tokens, p));
}

// A Project has a fixed pool of tracks (TRACK_POOL_SIZE) and a fixed 64-step
// buffer per track (the track's patternLength bounds the active window).
// `matchesPattern`'s `*` wildcard only checks that an index *looks* like a
// non-negative integer, not that it's in range — so `tracks.99.engineType`
// matches a pattern. This enforces the actual bounds, which both the client
// (pre-emit) and the server (before appendOp) rely on; without it an
// out-of-range index reaches the deep writer and throws instead of producing a
// clean nack.
const TRACK_COUNT = TRACK_POOL_SIZE;
const STEP_COUNT = 64;
export function indicesInRange(path: string): boolean {
  const tokens = tokenize(path);
  if (tokens[0] !== 'tracks') return true; // only `tracks.…` paths carry indices
  const trackIdx = Number(tokens[1]);
  if (!Number.isInteger(trackIdx) || trackIdx < 0 || trackIdx >= TRACK_COUNT) return false;
  if (tokens[2] === 'steps') {
    const stepIdx = Number(tokens[3]);
    if (!Number.isInteger(stepIdx) || stepIdx < 0 || stepIdx >= STEP_COUNT) return false;
  }
  if (tokens[2] === 'engines' && tokens[3] === 'synth2' && tokens[4] === 'matrix') {
    const slotIdx = Number(tokens[5]);
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= MATRIX_SLOT_COUNT) return false;
  }
  return true;
}

// Walk the Project schema tree following `tokens`, descending into the
// appropriate leaf schema. Numeric tokens descend into array element schemas.
// Returns the leaf schema, or null if the path doesn't resolve.
//
// We could derive this from Schemas.Project alone via .shape, but special-
// casing the few keys that matter is clearer and lets us short-circuit on the
// `engineType` discriminator inside `engines.<engineType>.<param>`.
export function resolveLeafSchema(path: string): z.ZodTypeAny | null {
  const tokens = tokenize(path);
  if (tokens.length === 0) return null;

  // Top-level scalar fields.
  if (tokens.length === 1) {
    if (tokens[0] === 'bpm') return Schemas.Project.shape.bpm;
    return null;
  }

  // Everything else starts with `tracks.<i>.…`.
  if (tokens[0] !== 'tracks') return null;
  if (!/^\d+$/.test(tokens[1])) return null;
  // From here on we're inside a Track. Field at index 2 picks the subtree.
  const trackKey = tokens[2];
  const trackShape = Schemas.Track.shape;

  if (trackKey === 'engineType' && tokens.length === 3) {
    return trackShape.engineType;
  }

  if (trackKey === 'patternLength' && tokens.length === 3) {
    return trackShape.patternLength;
  }

  if (trackKey === 'enabled' && tokens.length === 3) {
    return trackShape.enabled;
  }

  if (trackKey === 'mixer' && tokens.length === 4) {
    const mixerKey = tokens[3] as keyof typeof Schemas.Mixer.shape;
    return Schemas.Mixer.shape[mixerKey] ?? null;
  }

  if (trackKey === 'steps') {
    // tracks.<i>.steps.<j>.<field>
    if (tokens.length !== 5) return null;
    if (!/^\d+$/.test(tokens[3])) return null;
    const stepKey = tokens[4] as keyof typeof Schemas.Step.shape;
    return Schemas.Step.shape[stepKey] ?? null;
  }

  if (trackKey === 'engines') {
    // tracks.<i>.engines.<engineName>.<field>[.<sub>]
    const engineName = tokens[3] as keyof typeof Schemas.EnginesMap.shape;
    const engineSchema = Schemas.EnginesMap.shape[engineName];
    if (!engineSchema) return null;

    if (tokens.length === 5) {
      // Leaf param directly under the engine.
      const shape = (engineSchema as z.ZodObject<z.ZodRawShape>).shape;
      return shape[tokens[4]] ?? null;
    }

    if (tokens.length === 6 && engineName === 'synth') {
      // tracks.<i>.engines.synth.<envName>.<adsrField>
      const envName = tokens[4];
      if (envName !== 'filterEnv' && envName !== 'ampEnv') return null;
      const adsrField = tokens[5] as keyof typeof Schemas.ADSR.shape;
      return Schemas.ADSR.shape[adsrField] ?? null;
    }

    if (tokens.length === 6 && engineName === 'synth2') {
      // tracks.<i>.engines.synth2.<module>.<field> — leaf schemas are
      // generated alongside the nested schema; key format matches the
      // descriptor table.
      return SYNTH2_LEAF_SCHEMAS[`${tokens[4]}.${tokens[5]}`] ?? null;
    }

    if (tokens.length === 7 && engineName === 'synth2' && tokens[4] === 'matrix') {
      // tracks.<i>.engines.synth2.matrix.<s>.<source|dest|amount>
      const field = tokens[6] as keyof typeof Schemas.Synth2MatrixSlot.shape;
      return Schemas.Synth2MatrixSlot.shape[field] ?? null;
    }

    return null;
  }

  return null;
}

export type ValidatePathResult =
  | { ok: true }
  | { ok: false; code: 'path.invalid' | 'value.invalid'; message: string };

export function validatePathAndValue(path: string, value: unknown): ValidatePathResult {
  if (!pathIsWritable(path)) {
    return { ok: false, code: 'path.invalid', message: `path not writable: ${path}` };
  }
  if (!indicesInRange(path)) {
    return { ok: false, code: 'path.invalid', message: `index out of range: ${path}` };
  }
  const schema = resolveLeafSchema(path);
  if (!schema) {
    // Path matched a pattern but the schema tree didn't resolve. Treat as
    // path.invalid — the accept-list and the schema are out of sync, which is
    // a code bug, but on the wire we don't want to claim the value was bad.
    return { ok: false, code: 'path.invalid', message: `no schema for path: ${path}` };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: 'value.invalid',
      message: issue ? `${issue.path.join('.') || '<root>'}: ${issue.message}` : 'invalid value',
    };
  }
  return { ok: true };
}
