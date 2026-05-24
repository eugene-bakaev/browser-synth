import { type Project, PROJECT_SCHEMA_VERSION } from './types';
import { freshProject } from './factory';

// Single entry point. Given any value loaded from storage, return a project
// at the current schema version — or a freshProject() if the input is
// unrecognizable. Throws ONLY for a known-future version (which indicates the
// app was downgraded since the save was written; no safe recovery).
//
// Versioning policy (spec §6.1): bump only on breaking changes (rename,
// remove, semantic change). Additive changes are handled later by
// reconcileWithDefaults — not here.
export function migrateToLatest(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null) {
    return freshProject();
  }
  const v = (raw as { schemaVersion?: number }).schemaVersion;

  if (v === PROJECT_SCHEMA_VERSION) return raw as Project;

  if (typeof v === 'number') {
    throw new Error(
      `Unknown project schemaVersion: ${v}. App may be older than this save.`
    );
  }

  // Versioned-but-undefined (legacy / corruption / malformed)
  console.warn('Project missing schemaVersion, starting fresh');
  return freshProject();
}
