import { describe, it, expect } from 'vitest';
import { ConnectionPool } from './ConnectionPool.js';
import type { SocketLike } from './SocketLike.js';

function sock(readyState = 1): SocketLike {
  return { readyState, send() {}, close() {} } as unknown as SocketLike;
}

describe('ConnectionPool leak gauges', () => {
  it('totalConnections counts raw membership across all rooms', () => {
    const pool = new ConnectionPool();
    expect(pool.totalConnections()).toBe(0);
    const a = sock(), b = sock(), c = sock();
    pool.add('r1', a);
    pool.add('r1', b);
    pool.add('r2', c);
    expect(pool.totalConnections()).toBe(3);
    expect(pool.roomCount()).toBe(2);
  });

  it('counts a half-open (still readyState===1) socket until it is removed — reveals leaks', () => {
    const pool = new ConnectionPool();
    const stale = sock(1); // half-open TCP still reports OPEN
    pool.add('r1', stale);
    // size() filters by readyState, but totalConnections is raw membership:
    // a socket that should have been removed but wasn't still shows here.
    expect(pool.totalConnections()).toBe(1);
    pool.remove('r1', stale);
    expect(pool.totalConnections()).toBe(0);
    expect(pool.roomCount()).toBe(0);
  });
});
