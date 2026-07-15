import type { Project, ProjectTrack } from './types.js';
import { freshTrack } from './factory.js';
import { TRACK_POOL_SIZE } from './constants.js';
import { normalizeProject } from './normalize.js';

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
//
// `trackOrder` is optional here for the same version-skew reason it's optional
// on ProjectSchema: an old stored snapshot won't have it. Trivial passthrough
// for now (no sparse/identity-omission encoding, no validation) — the encoding
// and repair-on-missing behavior are owned by a later trackOrder task.
export interface StoredProject {
  schemaVersion: Project['schemaVersion'];
  bpm: number;
  trackOrder?: Project['trackOrder'];
  tracks: Record<string, ProjectTrack>;
}

// Lazily built (memoized) so this module has NO import-time side effect: a
// top-level freshTrack() call runs before factory.ts's imported constants are
// initialized when loaded via the barrel, causing a circular-import TDZ error.
// A slot equal to this pristine template carries no information and is omitted.
let pristineDisabled: ProjectTrack | undefined;
function getPristineDisabled(): ProjectTrack {
  return (pristineDisabled ??= freshTrack(false));
}

// Sparse StoredProject OR legacy full-array Project -> full 32-slot Project.
// Discriminator: `tracks` as an array => legacy full form; as an object => sparse
// (build 32 slots, filling absent indices with disabled fresh tracks). Defensive:
// anything unrecognized falls through to be healed by normalizeProject; never
// throws. Structure only — invariant repair stays with normalizeProject.
export function unpackProject(stored: unknown): Project {
  const s = (stored && typeof stored === 'object')
    ? (stored as { schemaVersion?: unknown; bpm?: unknown; trackOrder?: unknown; tracks?: unknown })
    : {};

  let tracks: ProjectTrack[];
  if (Array.isArray(s.tracks)) {
    tracks = s.tracks as ProjectTrack[]; // legacy full form
  } else if (s.tracks && typeof s.tracks === 'object') {
    const map = s.tracks as Record<string, ProjectTrack>;
    tracks = Array.from({ length: TRACK_POOL_SIZE }, (_, i) =>
      map[String(i)] ?? freshTrack(false),
    );
  } else {
    tracks = []; // normalizeProject will pad to TRACK_POOL_SIZE
  }

  return normalizeProject({
    schemaVersion: s.schemaVersion,
    bpm: s.bpm,
    trackOrder: s.trackOrder,
    tracks,
  } as Project);
}

// Full Project -> sparse StoredProject. A slot is kept iff it is enabled OR it
// differs from the pristine freshTrack(false) default (lossless for
// disabled-but-edited tracks; drops only untouched padding).
export function packProject(project: Project): StoredProject {
  const tracks: Record<string, ProjectTrack> = {};
  project.tracks.forEach((track, i) => {
    if (track.enabled || !deepEqual(track, getPristineDisabled())) {
      tracks[String(i)] = track;
    }
  });
  return { schemaVersion: project.schemaVersion, bpm: project.bpm, trackOrder: project.trackOrder, tracks };
}
