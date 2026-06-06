import postgres from 'postgres';
import type { Project } from '@fiddle/shared';
import { packProject, unpackProject } from '@fiddle/shared';
import type {
  CreateSessionInput,
  SessionRecord,
  SessionStore,
  UpdateMetaPatch,
} from './SessionStore.js';

// The connected-client type postgres() returns (the package doesn't export a
// clean named `Sql` type across versions, so derive it from the constructor).
type Sql = ReturnType<typeof postgres>;

// Derive the JSONValue type expected by sql.json() from the package itself so
// we don't hard-code a definition that could diverge. Used only for casts.
type JsonArg = Parameters<Sql['json']>[0];

interface SessionRow {
  id: string;
  name: string;
  description: string;
  owner_user_id: string | null;
  owner_client_id: string | null;
  settings: SessionRecord['settings'];
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    ownerClientId: row.owner_client_id,
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Writes/reads sessions via a privileged Postgres connection (DATABASE_URL).
// jsonb columns are written with sql.json() so objects serialise correctly.
export class PostgresSessionStore implements SessionStore {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const rows = await this.sql<SessionRow[]>`
      insert into sessions
        (id, name, description, owner_user_id, owner_client_id, settings)
      values
        (${input.id}, ${input.name}, ${input.description},
         ${input.ownerUserId}, ${input.ownerClientId}, ${this.sql.json(input.settings as unknown as JsonArg)})
      returning *
    `;
    await this.sql`
      insert into session_snapshots (session_id, project)
      values (${input.id}, ${this.sql.json(packProject(input.project) as unknown as JsonArg)})
    `;
    return toRecord(rows[0]!);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const rows = await this.sql<SessionRow[]>`
      select * from sessions where id = ${id} limit 1
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(): Promise<SessionRecord[]> {
    const rows = await this.sql<SessionRow[]>`
      select * from sessions order by updated_at desc
    `;
    return rows.map(toRecord);
  }

  async getSnapshot(id: string): Promise<Project | null> {
    const rows = await this.sql<{ project: unknown }[]>`
      select project from session_snapshots where session_id = ${id} limit 1
    `;
    return rows[0] ? unpackProject(rows[0].project) : null;
  }

  async saveSnapshot(id: string, project: Project): Promise<void> {
    const stored = packProject(project);
    // No-op if the session row is gone (matches InMemorySessionStore and the
    // interface contract). The `insert … select … where exists` guard means a
    // flush for a just-deleted/pruned session inserts nothing rather than
    // raising a foreign-key violation — important for the autosave sweep, which
    // can race a delete. When the session exists this behaves as a plain upsert.
    await this.sql`
      insert into session_snapshots (session_id, project, updated_at)
      select ${id}, ${this.sql.json(stored as unknown as JsonArg)}, now()
      where exists (select 1 from sessions where id = ${id})
      on conflict (session_id) do update
        set project = excluded.project, updated_at = now()
    `;
  }

  async updateMeta(id: string, patch: UpdateMetaPatch): Promise<void> {
    // Only touch provided fields; an unspecified field reuses its own column
    // value (a no-op assignment). updated_at always bumps.
    await this.sql`
      update sessions set
        name        = ${patch.name ?? this.sql`name`},
        description  = ${patch.description ?? this.sql`description`},
        settings     = ${patch.settings ? this.sql.json(patch.settings as unknown as JsonArg) : this.sql`settings`},
        updated_at  = now()
      where id = ${id}
    `;
  }

  async delete(id: string): Promise<void> {
    // session_snapshots row is removed by ON DELETE CASCADE.
    await this.sql`delete from sessions where id = ${id}`;
  }
}
