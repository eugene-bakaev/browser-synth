import type { Project, ProjectTrack } from './types.js';
import { freshTrack } from './factory.js';
import { TRACK_POOL_SIZE } from './constants.js';

// Bring any project up to the fixed track-pool shape: exactly TRACK_POOL_SIZE
// slots, each with a boolean `enabled`. Used at every deserialize boundary
// (client localStorage/file/snapshot, server snapshot load) so a legacy
// 4-track project never reaches code that assumes 32 slots.
//
// Semantics: a stored slot with no `enabled` is treated as enabled (it was an
// active track before this feature); padded slots are disabled. Idempotent —
// an already-normalized project is returned by reference (fast path), so this
// is cheap to call defensively.
export function normalizeTrackPool(project: Project): Project {
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  const alreadyNormal =
    tracks.length === TRACK_POOL_SIZE &&
    tracks.every(t => typeof t.enabled === 'boolean');
  if (alreadyNormal) return project;

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
  return { ...project, tracks: out };
}
