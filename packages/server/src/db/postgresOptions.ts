import type { Options, PostgresType } from 'postgres';

/**
 * Connection options for the Supabase Postgres client.
 *
 * Tuned for production reality: the server connects to Supabase's *transaction*
 * pooler (port 6543) over the internet, often from a Render instance that
 * hibernates and cold-starts. Two failure modes drove these settings, both
 * seen crashing the deployed server:
 *
 *   - ECHECKOUTTIMEOUT — the pooler couldn't hand out a connection in time.
 *   - CONNECTION_CLOSED / EDBHANDLEREXITED — we wrote to a socket the pooler had
 *     already closed (it drops idle server-side connections).
 *
 * `prepare: false` is mandatory: the transaction pooler does not support
 * prepared statements, which porsager/postgres uses by default. The idle and
 * lifetime caps make us recycle connections before the pooler kills them, so we
 * stop writing to dead sockets. `connect_timeout` bounds a stuck checkout so a
 * request fails fast (~10s) instead of hanging on the pooler's 15s ceiling.
 */
export const POSTGRES_OPTIONS = {
  prepare: false,
  idle_timeout: 20,
  max_lifetime: 60 * 5,
  connect_timeout: 10,
  max: 10,
} as const satisfies Options<Record<string, PostgresType>>;
