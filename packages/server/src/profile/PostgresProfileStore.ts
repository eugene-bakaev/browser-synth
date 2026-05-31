import postgres from 'postgres';
import type { ProfileStore } from './ProfileStore.js';

// The connected-client type postgres() returns (the package doesn't export a
// clean named `Sql` type across versions, so derive it from the constructor).
type Sql = ReturnType<typeof postgres>;

// Reads profiles via a privileged Postgres connection (not the anon key), so
// RLS — which guards only the browser's direct access — does not apply here.
// One indexed primary-key lookup per hello.
export class PostgresProfileStore implements ProfileStore {
  constructor(private readonly sql: Sql) {}

  async getUsername(userId: string): Promise<string | null> {
    const rows = await this.sql<{ username: string | null }[]>`
      select username from profiles where id = ${userId} limit 1
    `;
    return rows[0]?.username ?? null;
  }
}
