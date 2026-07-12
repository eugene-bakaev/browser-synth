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
    expect(formatKnobValue('hz', 1000)).toBe('1.0k');
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

describe('formatKnobValue — octave (LFO depth)', () => {
  it('shows zero as "0"', () => {
    expect(formatKnobValue('octave', 0)).toBe('0');
  });
  it('shows positive values with ↑ prefix (sweep opens)', () => {
    expect(formatKnobValue('octave', 2.4)).toBe('↑2.4');
    expect(formatKnobValue('octave', 1)).toBe('↑1');
  });
  it('shows negative values with ↓ prefix (sweep closes)', () => {
    expect(formatKnobValue('octave', -1.5)).toBe('↓1.5');
    expect(formatKnobValue('octave', -3)).toBe('↓3');
  });
});

describe('formatKnobValue — octaveSwitch (semitone leaf → octaves)', () => {
  it('renders whole octaves as signed integers', () => {
    expect(formatKnobValue('octaveSwitch', 0)).toBe('0');
    expect(formatKnobValue('octaveSwitch', 12)).toBe('+1');
    expect(formatKnobValue('octaveSwitch', 36)).toBe('+3');
    expect(formatKnobValue('octaveSwitch', -12)).toBe('-1');
    expect(formatKnobValue('octaveSwitch', -24)).toBe('-2');
  });
  it('rounds an off-octave (legacy) semitone value to the nearest octave label', () => {
    expect(formatKnobValue('octaveSwitch', 7)).toBe('+1'); // round(7/12) = 1
    expect(formatKnobValue('octaveSwitch', -5)).toBe('0'); // round(-5/12) = 0
  });
});

describe('formatKnobValue — db (perceptual dB)', () => {
  it('shows zero as "-∞ dB"', () => {
    expect(formatKnobValue('db', 0)).toBe('-∞ dB');
  });
  it('computes dB from slider position 0..1 range (-54..+6 dB with unity at 0.9)', () => {
    // -54 + 0.9 * 60 = -54 + 54 = 0 dB (no prefix at zero)
    expect(formatKnobValue('db', 0.9)).toBe('0.0 dB');
    // -54 + 0.5 * 60 = -54 + 30 = -24 dB
    expect(formatKnobValue('db', 0.5)).toBe('-24.0 dB');
    // -54 + 1.0 * 60 = -54 + 60 = 6 dB
    expect(formatKnobValue('db', 1.0)).toBe('+6.0 dB');
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
