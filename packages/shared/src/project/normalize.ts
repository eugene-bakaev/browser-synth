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

const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// The canonical fresh engine slices, used as the deep-heal template. Memoized:
// freshTrack() deep-clones the engine defaults, and we only ever read this copy
// (healSlice clones the subtrees it grafts), so one shared template is safe.
let _templateEngines: Record<string, unknown> | null = null;
function templateEngines(): Record<string, unknown> {
  if (!_templateEngines) {
    _templateEngines = freshTrack().engines as unknown as Record<string, unknown>;
  }
  return _templateEngines;
}

// Structural completeness: every key the template carries must be present in
// `loaded`, recursing into plain (non-array) objects. Arrays only need to BE an
// array (their element-level repair lives with the accept-list / client
// reconcile). Presence-only — a present-but-garbage value is left for the
// schema/accept-list to validate; this guards only against MISSING leaves
// (e.g. a session saved before a descriptor was appended).
function isComplete(loaded: unknown, template: unknown): boolean {
  if (!isObject(template)) return true;            // template leaf — caller checked presence
  if (!isObject(loaded)) return false;
  if (Array.isArray(template)) return Array.isArray(loaded);
  for (const key of Object.keys(template)) {
    if (!(key in loaded)) return false;
    if (isObject(template[key]) && !Array.isArray(template[key])) {
      if (!isComplete(loaded[key], template[key])) return false;
    }
  }
  return true;
}

// Deep-merge `loaded` onto the `template`: fill any key the template has but
// `loaded` lacks (deep-cloned from the template), keep every value `loaded`
// already has, recurse into plain objects, keep `loaded` arrays as-is, and
// preserve `loaded`'s extra keys (forward-compat). Only called on slices
// isComplete() rejected, so complete slices still ride through by reference.
function healSlice(loaded: unknown, template: unknown): unknown {
  if (!isObject(template)) return loaded;                          // template leaf — keep loaded
  if (!isObject(loaded)) return structuredClone(template);         // missing/garbage — take default
  if (Array.isArray(template)) {
    return Array.isArray(loaded) ? loaded : structuredClone(template);
  }
  const out: Record<string, unknown> = { ...loaded };
  for (const key of Object.keys(template)) {
    if (!(key in out)) {
      out[key] = structuredClone(template[key]);
    } else if (isObject(template[key]) && !Array.isArray(template[key])) {
      out[key] = healSlice(out[key], template[key]);
    }
  }
  return out;
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
//     every engine slice exists, patternLength is an integer in
//     [1, STEP_BUFFER_SIZE], and mixer is an object
//
// The repair is structural AND fills missing engine PARAM LEAVES from defaults
// (deep-merge): a present, complete engine slice keeps its values as-is and
// rides through by reference, but a slice saved before a descriptor was
// appended is healed leaf-by-leaf so the missing param can't reach the UI as
// `undefined`. Present values are never overwritten (only missing keys are
// filled); per-value validation still lives with the accept-list/schema.
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
    isObject(t.engines) &&
    ENGINE_KEYS.every(k => isComplete(t.engines[k], templateEngines()[k])) &&
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
    const template = (fresh.engines as unknown as Record<string, unknown>)[k];
    // A complete slice rides through by reference; only a missing or
    // leaf-incomplete slice is deep-healed from defaults.
    engines[k] = isComplete(slice, template) ? slice : healSlice(slice, template);
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
