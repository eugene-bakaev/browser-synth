// In-memory SessionStore for unit tests and the no-database fallback path.
// Snapshot writes do NOT bump the record's updatedAt — that mirrors the table
// split, where the 60s autosave flush touches only session_snapshots.updated_at
// and not sessions.updated_at (so the lobby's metadata ordering reflects
// metadata/settings activity, not every autosave tick).

import type { Project } from '@fiddle/shared';
import type {
  CreateSessionInput,
  SessionRecord,
  SessionStore,
  UpdateMetaPatch,
} from './SessionStore.js';

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly snapshots = new Map<string, Project>();

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date();
    const record: SessionRecord = {
      id: input.id,
      name: input.name,
      description: input.description,
      ownerUserId: input.ownerUserId,
      ownerClientId: input.ownerClientId,
      settings: input.settings,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(input.id, record);
    this.snapshots.set(input.id, input.project);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(): Promise<SessionRecord[]> {
    return [...this.records.values()].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  async getSnapshot(id: string): Promise<Project | null> {
    return this.snapshots.get(id) ?? null;
  }

  async saveSnapshot(id: string, project: Project): Promise<void> {
    if (!this.records.has(id)) return; // no row to attach to
    this.snapshots.set(id, project);
  }

  async updateMeta(id: string, patch: UpdateMetaPatch): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.description !== undefined) record.description = patch.description;
    if (patch.settings !== undefined) record.settings = patch.settings;
    record.updatedAt = new Date();
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
    this.snapshots.delete(id);
  }
}
