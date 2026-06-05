import type { Project, ProjectTrack } from './types.js';
import { freshTrack } from './factory.js';
import {
  TRACK_POOL_SIZE,
  DEFAULT_ENABLED_TRACKS,
  DEFAULT_BPM,
  BPM_MIN,
  BPM_MAX,
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

// Bring any project up to the canonical top-level shape and repair the
// invariants the rest of the app relies on. Used at every deserialize boundary
// (client localStorage/file/snapshot, server snapshot load + save) so a legacy
// or corrupted project never reaches code that assumes a well-formed project.
//
// Invariants enforced (a project is only returned unchanged when it ALREADY
// satisfies all of them — see `isAlreadyValid`):
//   - schemaVersion is the current PROJECT_SCHEMA_VERSION
//   - bpm is an integer within [BPM_MIN, BPM_MAX]
//   - exactly TRACK_POOL_SIZE slots
//   - every slot's `enabled` is a boolean
//   - at least one slot is enabled (the UI guarantees >=1 track; 0 enabled is
//     always corruption — heal by re-enabling the first DEFAULT_ENABLED_TRACKS)
//
// This owns the top-level Project contract (schemaVersion, bpm, track pool); it
// does NOT deep-repair track internals (engine params, steps) — that stays with
// the client's reconcileWithDefaults.
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
      out.push({
        ...existing,
        enabled: typeof existing.enabled === 'boolean' ? existing.enabled : true,
      });
    } else {
      out.push(freshTrack(false));
    }
  }

  // 0 enabled is never a legitimate state (the UI blocks removing the last
  // track), so a fully-disabled pool is corruption — restore the default count.
  if (!out.some(t => t.enabled)) {
    for (let i = 0; i < DEFAULT_ENABLED_TRACKS; i++) out[i].enabled = true;
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
    tracks.every(t => typeof t.enabled === 'boolean') &&
    tracks.some(t => t.enabled)
  );
}
