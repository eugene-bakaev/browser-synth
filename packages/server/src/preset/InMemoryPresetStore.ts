import type { PresetRecord } from '@fiddle/shared';
import type { CreatePresetInput, ListPresetsOpts, PresetStore } from './PresetStore.js';

interface Row extends Omit<PresetRecord, 'createdAt' | 'updatedAt'> {
  createdAt: Date;
  updatedAt: Date;
}

// Username attribution is resolved by the Postgres store via a join; the fake
// returns null (route/store tests that need it set it explicitly).
export class InMemoryPresetStore implements PresetStore {
  private readonly rows = new Map<string, Row>();

  async create(input: CreatePresetInput): Promise<PresetRecord> {
    const now = new Date();
    const row: Row = {
      id: input.id,
      name: input.name,
      engineType: input.engineType,
      params: input.params,
      ownerUserId: input.ownerUserId,
      ownerUsername: null,
      isPublic: input.isPublic,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(input.id, row);
    return toRecord(row);
  }

  async get(id: string): Promise<PresetRecord | null> {
    const row = this.rows.get(id);
    return row ? toRecord(row) : null;
  }

  async list(opts: ListPresetsOpts): Promise<PresetRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.isPublic || r.ownerUserId === opts.viewerUserId)
      .filter((r) => !opts.engineType || r.engineType === opts.engineType)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(toRecord);
  }

  async updateMeta(id: string, patch: { name?: string; isPublic?: boolean }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.isPublic !== undefined) row.isPublic = patch.isPublic;
    row.updatedAt = new Date();
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

function toRecord(row: Row): PresetRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
