import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { PostgresPresetStore } from './PostgresPresetStore.js';

// Integration test: only runs when TEST_DATABASE_URL points at a throwaway
// Postgres. Skipped in the default unit run (InMemoryPresetStore covers logic).
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresPresetStore (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: PostgresPresetStore;

  beforeAll(async () => {
    sql = postgres(url!);
    // Self-contained schema: no auth.users FK and a standalone profiles table
    // so the username join resolves without the real auth schema.
    await sql`create table if not exists profiles (id uuid primary key, username text)`;
    await sql`create table if not exists presets (
      id text primary key,
      name text not null,
      engine_type text not null,
      params jsonb not null,
      schema_version int not null default 1,
      owner_user_id uuid not null,
      is_public boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;
    store = new PostgresPresetStore(sql);
  });

  beforeEach(async () => {
    await sql`delete from presets`;
    await sql`delete from profiles`;
  });

  afterAll(async () => {
    await sql`drop table if exists presets`;
    await sql`drop table if exists profiles`;
    await sql.end();
  });

  const owner = '00000000-0000-0000-0000-000000000001';

  it('creates, reads, lists (own+public), patches, deletes', async () => {
    await sql`insert into profiles (id, username) values (${owner}, 'alice')`;
    const rec = await store.create({
      id: 'p1', name: 'Boom', engineType: 'kick2', params: { tune: 1 },
      ownerUserId: owner, isPublic: true,
    });
    expect(rec.name).toBe('Boom');

    const got = await store.get('p1');
    expect(got?.ownerUsername).toBe('alice'); // resolved via join
    expect(got?.isPublic).toBe(true);

    const guestView = await store.list({ viewerUserId: null });
    expect(guestView.map((r) => r.id)).toEqual(['p1']); // public visible to guests

    await store.updateMeta('p1', { name: 'Boom2', isPublic: false });
    expect((await store.get('p1'))?.name).toBe('Boom2');
    expect((await store.list({ viewerUserId: null })).length).toBe(0); // now private

    await store.delete('p1');
    expect(await store.get('p1')).toBeNull();
  });
});
