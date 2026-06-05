import { describe, it, expect } from 'vitest';
import { POSTGRES_OPTIONS } from './postgresOptions.js';

describe('POSTGRES_OPTIONS', () => {
  it('disables prepared statements (required for the Supabase transaction pooler)', () => {
    // The transaction pooler (port 6543) does not support prepared statements,
    // which porsager/postgres uses by default. Leaving this on causes
    // intermittent query failures on the pooler.
    expect(POSTGRES_OPTIONS.prepare).toBe(false);
  });

  it('bounds idle + lifetime so stale pooler sockets are recycled before use', () => {
    // The pooler closes idle server connections; recycling ours first avoids
    // writing to a half-dead socket (CONNECTION_CLOSED / EDBHANDLEREXITED).
    expect(POSTGRES_OPTIONS.idle_timeout).toBeGreaterThan(0);
    expect(POSTGRES_OPTIONS.max_lifetime).toBeGreaterThan(0);
  });

  it('bounds connect_timeout so a stuck checkout fails fast instead of hanging', () => {
    expect(POSTGRES_OPTIONS.connect_timeout).toBeGreaterThan(0);
    expect(POSTGRES_OPTIONS.connect_timeout).toBeLessThanOrEqual(15);
  });
});
