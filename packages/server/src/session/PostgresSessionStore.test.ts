import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { PostgresSessionStore } from './PostgresSessionStore.js';

// Integration test: only runs when TEST_DATABASE_URL points at a throwaway
// Postgres. Skipped in the default unit run (InMemorySessionStore covers logic).
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresSessionStore (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: PostgresSessionStore;

  beforeAll(async () => {
    sql = postgres(url!);
    // Minimal standalone schema (no auth.users FK) so the test is self-contained.
    await sql`create table if not exists sessions (
      id text primary key,
      name text not null,
      description text not null default '',
      owner_user_id uuid,
      owner_client_id text,
      settings jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;
    await sql`create table if not exists session_snapshots (
      session_id text primary key references sessions(id) on delete cascade,
      project jsonb not null,
      updated_at timestamptz not null default now()
    )`;
    store = new PostgresSessionStore(sql);
  });

  beforeEach(async () => {
    await sql`delete from sessions`; // cascades to session_snapshots
  });

  afterAll(async () => {
    await sql`drop table if exists session_snapshots`;
    await sql`drop table if exists sessions`;
    await sql.end();
  });

  it('create + get round-trips metadata and settings', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: 'd',
      ownerUserId: null, ownerClientId: 'client-9',
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const got = await store.get('s1');
    expect(got?.name).toBe('Jam');
    expect(got?.ownerClientId).toBe('client-9');
    expect(got?.settings).toEqual(DEFAULT_SESSION_SETTINGS);
  });

  it('getSnapshot returns the stored project; saveSnapshot upserts it', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: '',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const edited = freshProject();
    edited.bpm = 150;
    await store.saveSnapshot('s1', edited);
    expect((await store.getSnapshot('s1'))?.bpm).toBe(150);
  });

  it('saveSnapshot on a missing session is a no-op (no FK violation)', async () => {
    // Mirrors InMemorySessionStore: a flush racing a delete/prune must not throw.
    await store.saveSnapshot('ghost', freshProject());
    expect(await store.getSnapshot('ghost')).toBeNull();
  });

  it('updateMeta changes only provided fields', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: 'orig',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.updateMeta('s1', { description: 'changed' });
    const got = await store.get('s1');
    expect(got?.name).toBe('Jam');
    expect(got?.description).toBe('changed');
  });

  it('delete removes the row and cascades the snapshot', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: '',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.delete('s1');
    expect(await store.get('s1')).toBeNull();
    expect(await store.getSnapshot('s1')).toBeNull();
  });

  it('list returns most-recently-updated first', async () => {
    await store.create({
      id: 'a', name: 'A', description: '', ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.create({
      id: 'b', name: 'B', description: '', ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    await store.updateMeta('a', { name: 'A2' });
    expect((await store.list()).map((r) => r.id)).toEqual(['a', 'b']);
  });
});
