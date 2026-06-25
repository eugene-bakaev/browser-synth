import postgres from 'postgres';
import type { EngineType, PresetRecord } from '@fiddle/shared';
import type { CreatePresetInput, ListPresetsOpts, PresetStore } from './PresetStore.js';

type Sql = ReturnType<typeof postgres>;
type JsonArg = Parameters<Sql['json']>[0];

interface PresetRow {
  id: string;
  name: string;
  engine_type: string;
  params: unknown;
  owner_user_id: string;
  owner_username: string | null;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: PresetRow): PresetRecord {
  return {
    id: row.id,
    name: row.name,
    engineType: row.engine_type as EngineType,
    params: row.params,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    isPublic: row.is_public,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// SELECT list with the username join, reused by get() and list().
const SELECT = (sql: Sql) => sql`
  select p.id, p.name, p.engine_type, p.params, p.owner_user_id,
         pr.username as owner_username, p.is_public, p.created_at, p.updated_at
  from presets p
  left join profiles pr on pr.id = p.owner_user_id
`;

export class PostgresPresetStore implements PresetStore {
  constructor(private readonly sql: Sql) {}

  async create(input: CreatePresetInput): Promise<PresetRecord> {
    await this.sql`
      insert into presets (id, name, engine_type, params, owner_user_id, is_public)
      values (${input.id}, ${input.name}, ${input.engineType},
              ${this.sql.json(input.params as JsonArg)}, ${input.ownerUserId}, ${input.isPublic})
    `;
    const rec = await this.get(input.id);
    if (!rec) throw new Error('preset vanished immediately after insert');
    return rec;
  }

  async get(id: string): Promise<PresetRecord | null> {
    const rows = await this.sql<PresetRow[]>`${SELECT(this.sql)} where p.id = ${id} limit 1`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(opts: ListPresetsOpts): Promise<PresetRecord[]> {
    const viewer = opts.viewerUserId; // string | null
    const rows = await this.sql<PresetRow[]>`
      ${SELECT(this.sql)}
      where (p.is_public or p.owner_user_id = ${viewer})
      ${opts.engineType ? this.sql`and p.engine_type = ${opts.engineType}` : this.sql``}
      order by p.updated_at desc
      limit 500
    `;
    return rows.map(toRecord);
  }

  async updateMeta(id: string, patch: { name?: string; isPublic?: boolean }): Promise<void> {
    await this.sql`
      update presets set
        name      = ${patch.name ?? this.sql`name`},
        is_public = ${patch.isPublic ?? this.sql`is_public`},
        updated_at = now()
      where id = ${id}
    `;
  }

  async delete(id: string): Promise<void> {
    await this.sql`delete from presets where id = ${id}`;
  }
}
