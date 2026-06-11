import type { EngineParamsMap, Project, ProjectTrack, Step } from './types.js';
import { freshStep, freshTrack } from './factory.js';
import {
  TRACK_POOL_SIZE,
  DEFAULT_ENABLED_TRACKS,
  DEFAULT_BPM,
  BPM_MIN,
  BPM_MAX,
  STEP_BUFFER_SIZE,
  DEFAULT_PATTERN_LENGTH,
} from './constants.js';
import { PROJECT_SCHEMA_VERSION } from '../index.js';

// The one definition of a valid bpm. Round to integer, clamp to the shared
// [BPM_MIN, BPM_MAX] band, and fall back to DEFAULT_BPM for anything not a
// finite number (undefined/null/NaN/string). Used by both repair paths
// (normalizeProject on the sync/server boundary, reconcileWithDefaults on the
// client offline boundary) so a blank/garbage bpm can never survive a load.
export function coerceBpm(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_BPM;
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(n)));
}

const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Bring any project up to the canonical shape and repair the invariants the
// rest of the app relies on. Used at every deserialize boundary (client
// localStorage/file/snapshot, server snapshot load + save) so a legacy or
// corrupted project never reaches code that assumes a well-formed project.
//
// Invariants enforced (a project is only returned unchanged when it ALREADY
// satisfies all of them — see `isAlreadyValid`):
//   - schemaVersion is the current PROJECT_SCHEMA_VERSION
//   - bpm is an integer within [BPM_MIN, BPM_MAX]
//   - exactly TRACK_POOL_SIZE slots
//   - every slot's `enabled` is a boolean
//   - at least one slot is enabled (the UI guarantees >=1 track; 0 enabled is
//     always corruption — heal by re-enabling the first DEFAULT_ENABLED_TRACKS)
//   - every track is structurally sound: `steps` is exactly STEP_BUFFER_SIZE
//     object entries (legacy 16-step buffers are padded; sparse holes filled),
//     all five engine slices exist, patternLength is an integer in
//     [1, STEP_BUFFER_SIZE], and mixer is an object
//
// The repair is structural (slice-level), not param-level: a present engine
// slice or step keeps its values as-is. Param-by-param healing against
// defaults stays with the client's reconcileWithDefaults (offline boundary) —
// the sync path validates individual values per-op via the accept-list, so
// structure is the only thing this boundary must guarantee.
//
// Semantics: a stored slot with no `enabled` is treated as enabled (it was an
// active track before this feature); padded slots are disabled. Idempotent — an
// already-valid project is returned by reference (fast path), so this is cheap
// to call defensively.
export function normalizeProject(project: Project): Project {
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];

  if (isAlreadyValid(project, tracks)) return project;

  const out: ProjectTrack[] = [];
  for (let i = 0; i < TRACK_POOL_SIZE; i++) {
    const existing = tracks[i];
    if (existing) {
      out.push(isValidTrack(existing) ? existing : repairTrack(existing));
    } else {
      out.push(freshTrack(false));
    }
  }

  // 0 enabled is never a legitimate state (the UI blocks removing the last
  // track), so a fully-disabled pool is corruption — restore the default count.
  // Copy-on-heal: valid tracks ride through by reference, so don't mutate them.
  if (!out.some(t => t.enabled)) {
    for (let i = 0; i < DEFAULT_ENABLED_TRACKS; i++) out[i] = { ...out[i], enabled: true };
  }

  return {
    ...project,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: coerceBpm(project.bpm),
    tracks: out,
  };
}

function isAlreadyValid(project: Project, tracks: ProjectTrack[]): boolean {
  return (
    project.schemaVersion === PROJECT_SCHEMA_VERSION &&
    Number.isInteger(project.bpm) && project.bpm >= BPM_MIN && project.bpm <= BPM_MAX &&
    tracks.length === TRACK_POOL_SIZE &&
    tracks.every(isValidTrack) &&
    tracks.some(t => t.enabled)
  );
}

function isValidTrack(t: ProjectTrack): boolean {
  return (
    typeof t.enabled === 'boolean' &&
    Number.isInteger(t.patternLength) &&
    t.patternLength >= 1 && t.patternLength <= STEP_BUFFER_SIZE &&
    isObject(t.mixer) &&
    isObject(t.engines) && ENGINE_KEYS.every(k => isObject(t.engines[k])) &&
    Array.isArray(t.steps) && t.steps.length === STEP_BUFFER_SIZE &&
    t.steps.every(isObject)
  );
}

// Structural repair for one track. Present pieces are kept by reference;
// only what's missing/malformed is replaced from the fresh-track template.
function repairTrack(t: ProjectTrack): ProjectTrack {
  const fresh = freshTrack();
  const loadedEngines: Record<string, unknown> = isObject(t.engines) ? t.engines : {};
  const engines: Record<string, unknown> = {};
  for (const k of ENGINE_KEYS) {
    const slice = loadedEngines[k];
    engines[k] = isObject(slice) ? slice : fresh.engines[k];
  }

  // A legacy (pre-64-step) or sparse buffer is padded in place: stored steps
  // keep their position so patterns survive the migration; holes and overflow
  // become/stay fresh steps.
  const loadedSteps: unknown[] = Array.isArray(t.steps) ? t.steps : [];
  const steps: Step[] = Array.from({ length: STEP_BUFFER_SIZE }, (_, j) => {
    const s = loadedSteps[j];
    return typeof s === 'object' && s !== null ? (s as Step) : freshStep();
  });

  const patternLength = typeof t.patternLength === 'number' && Number.isFinite(t.patternLength)
    ? Math.min(STEP_BUFFER_SIZE, Math.max(1, Math.round(t.patternLength)))
    : DEFAULT_PATTERN_LENGTH;

  return {
    ...t, // forward-compat: keep unknown extras
    engines: engines as unknown as EngineParamsMap,
    mixer: isObject(t.mixer) ? t.mixer : fresh.mixer,
    patternLength,
    steps,
    enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
  };
}
