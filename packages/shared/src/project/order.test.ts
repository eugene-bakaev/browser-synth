import { describe, it, expect } from 'vitest';
import {
  identityTrackOrder,
  isValidTrackOrder,
  coerceTrackOrder,
  ordersEqual,
  moveTrackBefore,
} from './order.js';
import { TRACK_POOL_SIZE } from './constants.js';

describe('identityTrackOrder', () => {
  it('is 0..TRACK_POOL_SIZE-1 in order', () => {
    const o = identityTrackOrder();
    expect(o).toHaveLength(TRACK_POOL_SIZE);
    expect(o[0]).toBe(0);
    expect(o[TRACK_POOL_SIZE - 1]).toBe(TRACK_POOL_SIZE - 1);
  });
  it('returns a fresh array each call', () => {
    expect(identityTrackOrder()).not.toBe(identityTrackOrder());
  });
});

describe('isValidTrackOrder', () => {
  it('accepts the identity permutation', () => {
    expect(isValidTrackOrder(identityTrackOrder())).toBe(true);
  });
  it('accepts a shuffled permutation', () => {
    const o = identityTrackOrder().reverse();
    expect(isValidTrackOrder(o)).toBe(true);
  });
  it('rejects non-arrays, wrong length, duplicates, out-of-range, floats', () => {
    expect(isValidTrackOrder(undefined)).toBe(false);
    expect(isValidTrackOrder(null)).toBe(false);
    expect(isValidTrackOrder('0,1,2')).toBe(false);
    expect(isValidTrackOrder(identityTrackOrder().slice(1))).toBe(false);
    const dupes = identityTrackOrder(); dupes[1] = 0;
    expect(isValidTrackOrder(dupes)).toBe(false);
    const oor = identityTrackOrder(); oor[0] = TRACK_POOL_SIZE;
    expect(isValidTrackOrder(oor)).toBe(false);
    const float = identityTrackOrder(); float[0] = 0.5;
    expect(isValidTrackOrder(float)).toBe(false);
  });
});

describe('coerceTrackOrder', () => {
  it('passes a valid order through by reference', () => {
    const o = identityTrackOrder().reverse();
    expect(coerceTrackOrder(o)).toBe(o);
  });
  it('heals anything invalid to identity', () => {
    expect(coerceTrackOrder(undefined)).toEqual(identityTrackOrder());
    expect(coerceTrackOrder([1, 1, 1])).toEqual(identityTrackOrder());
  });
});

describe('ordersEqual', () => {
  it('true for same content, false for different', () => {
    expect(ordersEqual(identityTrackOrder(), identityTrackOrder())).toBe(true);
    expect(ordersEqual(identityTrackOrder(), identityTrackOrder().reverse())).toBe(false);
  });
});

describe('moveTrackBefore', () => {
  // Small orders keep the cases readable; the helper is length-agnostic.
  it('moves earlier (before a later anchor)', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 0, 3)).toEqual([1, 2, 0, 3]);
  });
  it('moves later (before an earlier anchor)', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 3, 1)).toEqual([0, 3, 1, 2]);
  });
  it('null anchor moves to the end', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 1, null)).toEqual([0, 2, 3, 1]);
  });
  it('moving before itself is a content no-op (fresh array)', () => {
    const order = [0, 1, 2, 3];
    const next = moveTrackBefore(order, 2, 2);
    expect(next).toEqual(order);
    expect(next).not.toBe(order);
  });
  it('moving before its current successor is a content no-op', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 1, 2)).toEqual([0, 1, 2, 3]);
  });
  it('unknown anchor falls back to end', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 0, 99)).toEqual([1, 2, 3, 0]);
  });
});
