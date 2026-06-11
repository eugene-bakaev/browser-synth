import { describe, it, expect } from 'vitest';
import { KeyedTokenBucket } from './rate-limit.js';

describe('KeyedTokenBucket', () => {
  it('allows a burst up to capacity, then rejects', () => {
    const limiter = new KeyedTokenBucket(3, 1000);
    const t = 1_000_000;
    expect(limiter.consume('ip1', t)).toBe(true);
    expect(limiter.consume('ip1', t)).toBe(true);
    expect(limiter.consume('ip1', t)).toBe(true);
    expect(limiter.consume('ip1', t)).toBe(false);
  });

  it('refills one token per interval, capped at capacity', () => {
    const limiter = new KeyedTokenBucket(2, 1000);
    const t = 1_000_000;
    expect(limiter.consume('ip1', t)).toBe(true);
    expect(limiter.consume('ip1', t)).toBe(true);
    expect(limiter.consume('ip1', t + 999)).toBe(false);  // not yet
    expect(limiter.consume('ip1', t + 1000)).toBe(true);  // one back
    expect(limiter.consume('ip1', t + 1000)).toBe(false); // only one
    // A long idle stretch refills to capacity, not beyond.
    expect(limiter.consume('ip1', t + 100_000)).toBe(true);
    expect(limiter.consume('ip1', t + 100_000)).toBe(true);
    expect(limiter.consume('ip1', t + 100_000)).toBe(false);
  });

  it('keys are independent budgets', () => {
    const limiter = new KeyedTokenBucket(1, 1000);
    const t = 1_000_000;
    expect(limiter.consume('ip1', t)).toBe(true);
    expect(limiter.consume('ip1', t)).toBe(false);
    expect(limiter.consume('ip2', t)).toBe(true); // unaffected by ip1
  });

  it('bounds memory: the oldest key is evicted past maxKeys (and refills on return)', () => {
    const limiter = new KeyedTokenBucket(1, 1000, 2);
    const t = 1_000_000;
    expect(limiter.consume('a', t)).toBe(true);
    expect(limiter.consume('b', t)).toBe(true);
    expect(limiter.consume('c', t)).toBe(true); // evicts 'a'
    // 'a' comes back as a fresh (full) bucket — eviction errs permissive.
    expect(limiter.consume('a', t)).toBe(true);
  });
});
