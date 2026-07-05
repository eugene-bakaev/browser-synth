import { describe, it, expect } from 'vitest';
import { formatKnobValue } from './knobFormat';

describe('formatKnobValue — hz (Part A: sub-10 decimals)', () => {
  it('shows decimals below 10 Hz (trailing zeros trimmed)', () => {
    expect(formatKnobValue('hz', 0.25)).toBe('0.25Hz');
    expect(formatKnobValue('hz', 0.5)).toBe('0.5Hz');
    expect(formatKnobValue('hz', 2.5)).toBe('2.5Hz');
    expect(formatKnobValue('hz', 9.99)).toBe('9.99Hz');
  });
  it('rounds to whole Hz from 10 up to 1000 (unchanged)', () => {
    expect(formatKnobValue('hz', 10)).toBe('10Hz');
    expect(formatKnobValue('hz', 440)).toBe('440Hz');
    expect(formatKnobValue('hz', 999)).toBe('999Hz');
  });
  it('uses k above 1000 (unchanged)', () => {
    expect(formatKnobValue('hz', 2000)).toBe('2.0k');
  });
});

describe('formatKnobValue — labels', () => {
  it('renders labels[round(value)] when a labels array is given', () => {
    const labels = ['1/1', '1/2', '1/4', '1/8'];
    expect(formatKnobValue(undefined, 0, labels)).toBe('1/1');
    expect(formatKnobValue('hz', 2, labels)).toBe('1/4'); // labels win over format
    expect(formatKnobValue(undefined, 2.4, labels)).toBe('1/4'); // rounds
  });
  it('falls back to normal formatting when labels is absent or out of range', () => {
    expect(formatKnobValue('percent', 0.5)).toBe('50%');
    expect(formatKnobValue(undefined, 9, ['a', 'b'])).toBe('9'); // index 9 out of range
  });
});

describe('formatKnobValue — existing formats unchanged', () => {
  it('formats percent / ms / cents / ratio', () => {
    expect(formatKnobValue('percent', 0.5)).toBe('50%');
    expect(formatKnobValue('ms', 0.2)).toBe('200ms');
    expect(formatKnobValue('cents', 7)).toBe('+7c');
    expect(formatKnobValue('ratio', 1.25)).toBe('1.3');
  });
  it('handles undefined/NaN value as empty string', () => {
    expect(formatKnobValue('hz', NaN)).toBe('');
  });
});
