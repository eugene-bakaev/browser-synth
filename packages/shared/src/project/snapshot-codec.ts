import type { Project, ProjectTrack } from './types.js';
import { freshTrack } from './factory.js';

// Structural, key-order-insensitive deep equality. Used only to decide whether
// a disabled slot is still the pristine freshTrack(false) default (and so can be
// omitted from the stored snapshot). JSON.stringify is unsafe here because a
// legacy-loaded track may carry a different key order than a freshly built one.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

// The sparse form persisted to the DB. `tracks` is keyed by stringified pool
// index ("0".."31") and contains ONLY slots that carry information. Top-level
// schemaVersion + bpm are carried through unchanged.
export interface StoredProject {
  schemaVersion: Project['schemaVersion'];
  bpm: number;
  tracks: Record<string, ProjectTrack>;
}

// The one pristine-disabled template; a slot equal to this carries no
// information and is omitted from the stored form. Built once (read-only).
const PRISTINE_DISABLED: ProjectTrack = freshTrack(false);

// Full Project -> sparse StoredProject. A slot is kept iff it is enabled OR it
// differs from the pristine freshTrack(false) default (lossless for
// disabled-but-edited tracks; drops only untouched padding).
export function packProject(project: Project): StoredProject {
  const tracks: Record<string, ProjectTrack> = {};
  project.tracks.forEach((track, i) => {
    if (track.enabled || !deepEqual(track, PRISTINE_DISABLED)) {
      tracks[String(i)] = track;
    }
  });
  return { schemaVersion: project.schemaVersion, bpm: project.bpm, tracks };
}
