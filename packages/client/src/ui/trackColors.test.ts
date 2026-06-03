import { describe, it, expect } from 'vitest';
import { trackColor } from './trackColors';
import { TRACK_POOL_SIZE } from '@fiddle/shared';

describe('trackColor', () => {
  it('keeps the original four colors for indices 0-3', () => {
    expect(trackColor(0)).toBe('#00f0ff');
    expect(trackColor(1)).toBe('#c084fc');
    expect(trackColor(2)).toBe('#fb923c');
    expect(trackColor(3)).toBe('#4ade80');
  });

  it('returns a non-empty color string for every pool slot', () => {
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      expect(trackColor(i)).toMatch(/\S/);
    }
  });
});
