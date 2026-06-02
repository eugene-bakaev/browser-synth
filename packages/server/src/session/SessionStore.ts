// SessionStore — the persistence surface for durable sessions. Mirrors the
// ProfileStore / RoomStore pattern: async so the Postgres implementation drops
// in behind the same interface the in-memory fake satisfies.
//
// Two concerns, deliberately separate columns/tables behind one store:
//   - metadata (SessionRecord): small, listed frequently in the lobby.
//   - the project snapshot (getSnapshot/saveSnapshot): the ~28KB jsonb blob,
//     loaded only when entering a session and rewritten by the autosave flusher.

import type { Project, SessionSettings } from '@fiddle/shared';

export interface SessionRecord {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;   // set for logged-in owners; null for guests
  ownerClientId: string | null; // guest creator's clientId; null for logged-in
  settings: SessionSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSessionInput {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  ownerClientId: string | null;
  settings: SessionSettings;
  project: Project; // the initial snapshot (default project or imported JSON)
}

export interface UpdateMetaPatch {
  name?: string;
  description?: string;
  settings?: SessionSettings;
}

export interface SessionStore {
  // Creates the metadata row + its initial snapshot row together.
  create(input: CreateSessionInput): Promise<SessionRecord>;
  // Metadata only; null if no such session.
  get(id: string): Promise<SessionRecord | null>;
  // All sessions, most-recently-updated first. The lobby endpoint (Plan 2)
  // decides which to surface; the store does not filter.
  list(): Promise<SessionRecord[]>;
  // The current project snapshot; null if the session/snapshot is absent.
  getSnapshot(id: string): Promise<Project | null>;
  // UPSERT the current snapshot. No-op if the session row does not exist.
  saveSnapshot(id: string, project: Project): Promise<void>;
  // Patch metadata fields; only provided fields change. No-op if absent.
  updateMeta(id: string, patch: UpdateMetaPatch): Promise<void>;
  // Removes the session and (via cascade in Postgres) its snapshot.
  delete(id: string): Promise<void>;
}
