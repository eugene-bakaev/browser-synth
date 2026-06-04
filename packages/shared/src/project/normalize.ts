import type { Project, ProjectTrack } from './types.js';
import { freshTrack } from './factory.js';
import { TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './constants.js';
import { PROJECT_SCHEMA_VERSION } from '../index.js';

// Bring any project up to the fixed track-pool shape and repair the invariants
// the rest of the app relies on. Used at every deserialize boundary (client
// localStorage/file/snapshot, server snapshot load + save) so a legacy or
// corrupted project never reaches code that assumes a well-formed 32-slot pool.
//
// Invariants enforced (a project is only returned unchanged when it ALREADY
// satisfies all of them — see `isAlreadyValid`):
//   - exactly TRACK_POOL_SIZE slots
//   - every slot's `enabled` is a boolean
//   - at least one slot is enabled (the UI guarantees >=1 track; 0 enabled is
//     always corruption — heal by re-enabling the first DEFAULT_ENABLED_TRACKS)
//   - schemaVersion is the current PROJECT_SCHEMA_VERSION
//
// Semantics: a stored slot with no `enabled` is treated as enabled (it was an
// active track before this feature); padded slots are disabled. Idempotent — an
// already-valid project is returned by reference (fast path), so this is cheap
// to call defensively.
export function normalizeTrackPool(project: Project): Project {
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

  return { ...project, schemaVersion: PROJECT_SCHEMA_VERSION, tracks: out };
}

function isAlreadyValid(project: Project, tracks: ProjectTrack[]): boolean {
  return (
    project.schemaVersion === PROJECT_SCHEMA_VERSION &&
    tracks.length === TRACK_POOL_SIZE &&
    tracks.every(t => typeof t.enabled === 'boolean') &&
    tracks.some(t => t.enabled)
  );
}
