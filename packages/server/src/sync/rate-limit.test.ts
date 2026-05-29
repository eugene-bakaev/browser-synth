import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenBucket } from './rate-limit.js';

// The bucket seeds `lastRefill = Date.now()` in its constructor and then
// compares against the `now` arg of every `consume`. We freeze Date.now so the
// constructor's seed and the explicit consume(now) values share a clock.

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at full capacity (200)', () => {
    const bucket = new TokenBucket();
    let allowed = 0;
    // 250 attempts with time frozen at t=0 → exactly 200 should pass.
    for (let i = 0; i < 250; i++) {
      if (bucket.consume(0)) allowed += 1;
    }
    expect(allowed).toBe(200);
  });

  it('refills at 100 tokens/sec', () => {
    const bucket = new TokenBucket();
    // Drain the burst at t=0.
    for (let i = 0; i < 200; i++) bucket.consume(0);
    expect(bucket.consume(0)).toBe(false);

    // 1 second later the bucket should have 100 tokens (capped well below
    // CAPACITY=200 because we just drained it). The next consume succeeds.
    expect(bucket.consume(1000)).toBe(true);

    // Now drain what's left at t=1000.
    let allowed = 1; // counting the consume above
    for (let i = 0; i < 110; i++) {
      if (bucket.consume(1000)) allowed += 1;
    }
    // We expect ~100 tokens total in the 1000ms refill window.
    expect(allowed).toBeGreaterThanOrEqual(99);
    expect(allowed).toBeLessThanOrEqual(101);
  });
});
