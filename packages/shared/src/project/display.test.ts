import { describe, it, expect } from 'vitest';
import { trackDisplayName } from './display.js';

describe('trackDisplayName', () => {
  it('returns the custom name when set', () => {
    expect(trackDisplayName({ name: 'Bassline' }, 0)).toBe('Bassline');
  });

  it('falls back to Track N (1-based) when empty', () => {
    expect(trackDisplayName({ name: '' }, 0)).toBe('Track 1');
    expect(trackDisplayName({ name: '' }, 7)).toBe('Track 8');
  });

  it('treats whitespace-only as unnamed', () => {
    expect(trackDisplayName({ name: '   ' }, 2)).toBe('Track 3');
  });

  it('trims the displayed name', () => {
    expect(trackDisplayName({ name: '  Kick  ' }, 0)).toBe('Kick');
  });
});
