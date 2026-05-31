import { describe, it, expect } from 'vitest';
import { clampStepField } from './stepFields';

describe('clampStepField', () => {
  it('parses a plain integer within range', () => {
    expect(clampStepField('5', 0, 8, 3)).toBe(5);
  });

  it('rounds a fractional value', () => {
    expect(clampStepField('4.6', 0, 8, 3)).toBe(5);
  });

  it('clamps above the max', () => {
    expect(clampStepField('99', 1, 16, 4)).toBe(16);
  });

  it('clamps below the min', () => {
    expect(clampStepField('-3', 0, 8, 3)).toBe(0);
  });

  it('returns the fallback for an empty string', () => {
    expect(clampStepField('', 0, 8, 3)).toBe(3);
  });

  it('returns the fallback for whitespace only', () => {
    expect(clampStepField('   ', 1, 16, 7)).toBe(7);
  });

  it('returns the fallback for non-numeric input', () => {
    expect(clampStepField('abc', 0, 8, 2)).toBe(2);
  });

  it('accepts the min boundary', () => {
    expect(clampStepField('1', 1, 16, 4)).toBe(1);
  });

  it('accepts the max boundary', () => {
    expect(clampStepField('8', 0, 8, 3)).toBe(8);
  });

  it('treats 0 as a valid value, not falsy-missing', () => {
    expect(clampStepField('0', 0, 8, 3)).toBe(0);
  });
});
