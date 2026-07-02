import { describe, it, expect } from 'vitest';
import { diffParams } from './paramDiff';

describe('diffParams', () => {
  it('returns null when there is no oldVal (first application)', () => {
    expect(diffParams({ a: 1 }, undefined)).toBeNull();
  });

  it('returns null when nothing changed', () => {
    expect(diffParams({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeNull();
  });

  it('returns only the changed scalar keys', () => {
    expect(diffParams({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, c: 3 })).toEqual({ b: 2 });
  });

  it('treats deep-equal nested objects as unchanged (JSON compare)', () => {
    expect(diffParams({ env: { a: 1, d: 2 } }, { env: { a: 1, d: 2 } })).toBeNull();
  });

  it('returns the whole nested object when a nested leaf changed', () => {
    const out = diffParams({ env: { a: 1, d: 2 } }, { env: { a: 1, d: 9 } });
    expect(out).toEqual({ env: { a: 1, d: 2 } });
  });
});
