import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { PostgresProfileStore } from './PostgresProfileStore.js';

// Integration test: only runs when TEST_DATABASE_URL points at a throwaway
// Postgres. Skipped in the default unit run (the in-memory fake covers logic).
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresProfileStore (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: PostgresProfileStore;

  beforeAll(async () => {
    sql = postgres(url!);
    await sql`create table if not exists profiles (id text primary key, username text unique)`;
    await sql`insert into profiles (id, username) values ('u-known', 'Known') on conflict (id) do nothing`;
    store = new PostgresProfileStore(sql);
  });

  afterAll(async () => {
    await sql`drop table if exists profiles`;
    await sql.end();
  });

  it('returns the username for an existing row', async () => {
    expect(await store.getUsername('u-known')).toBe('Known');
  });

  it('returns null for a missing row', async () => {
    expect(await store.getUsername('u-absent')).toBeNull();
  });
});
