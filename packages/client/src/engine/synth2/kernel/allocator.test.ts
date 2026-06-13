import { describe, it, expect } from 'vitest';
import { pickVoice } from './allocator';

describe('pickVoice', () => {
  const ages = [0, 0, 0, 0, 0, 0, 0, 0];

  it('returns the round-robin start when it is free', () => {
    const active = new Array(8).fill(false);
    expect(pickVoice(active, ages, 3)).toBe(3);
  });

  it('skips active voices, scanning forward (wrapping) from rrStart', () => {
    const active = [false, false, true, true, false, false, false, false];
    // rrStart 2 is active, 3 active, 4 free
    expect(pickVoice(active, ages, 2)).toBe(4);
    // wraps past the end
    const active2 = [false, true, true, true, true, true, true, true];
    expect(pickVoice(active2, ages, 6)).toBe(0);
  });

  it('steals the oldest (smallest age) active voice when none are free', () => {
    const active = new Array(8).fill(true);
    const someAges = [50, 10, 90, 30, 70, 5, 60, 40];
    expect(pickVoice(active, someAges, 0)).toBe(5); // age 5 is oldest
  });
});
