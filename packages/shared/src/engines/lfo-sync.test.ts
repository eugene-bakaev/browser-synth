import { describe, it, expect } from 'vitest';
import {
  LFO_SYNC_DIVISIONS, LFO_SYNC_LABELS, LFO_SYNC_DEFAULT_LABEL,
  LFO_SYNC_DEFAULT_INDEX, divisionToHz, divisionLabelToIndex,
} from './lfo-sync.js';

describe('LFO_SYNC_DIVISIONS', () => {
  it('has 18 entries with unique labels', () => {
    expect(LFO_SYNC_DIVISIONS).toHaveLength(18);
    expect(new Set(LFO_SYNC_LABELS).size).toBe(18);
  });

  it('is ordered slowest → fastest (strictly descending beats-per-cycle)', () => {
    for (let i = 1; i < LFO_SYNC_DIVISIONS.length; i++) {
      expect(LFO_SYNC_DIVISIONS[i].beats).toBeLessThan(LFO_SYNC_DIVISIONS[i - 1].beats);
    }
  });

  it('defaults to 1/16 at index 13', () => {
    expect(LFO_SYNC_DEFAULT_LABEL).toBe('1/16');
    expect(LFO_SYNC_DEFAULT_INDEX).toBe(13);
    expect(LFO_SYNC_LABELS[13]).toBe('1/16');
  });
});

describe('divisionToHz', () => {
  it('derives Hz = bpm / (60 * beats) at 120 BPM', () => {
    expect(divisionToHz('1/4', 120)).toBeCloseTo(2, 6);      // 1 beat/cycle
    expect(divisionToHz('1/16', 120)).toBeCloseTo(8, 6);     // 0.25 beat/cycle
    expect(divisionToHz('1/1', 120)).toBeCloseTo(0.5, 6);    // 4 beats/cycle
    expect(divisionToHz('1/1.', 120)).toBeCloseTo(1 / 3, 6); // 6 beats/cycle
    expect(divisionToHz('1/32T', 120)).toBeCloseTo(24, 6);   // 1/12 beat/cycle
  });

  it('scales with BPM', () => {
    expect(divisionToHz('1/4', 60)).toBeCloseTo(1, 6);
    expect(divisionToHz('1/4', 140)).toBeCloseTo(140 / 60, 6);
  });

  it('falls back to the default division for an unknown label (never NaN)', () => {
    expect(divisionToHz('bogus', 120)).toBe(divisionToHz('1/16', 120));
    expect(Number.isNaN(divisionToHz('bogus', 120))).toBe(false);
  });
});

describe('divisionLabelToIndex', () => {
  it('maps a known label to its index', () => {
    expect(divisionLabelToIndex('1/16')).toBe(13);
    expect(divisionLabelToIndex('1/1.')).toBe(0);
    expect(divisionLabelToIndex('1/32T')).toBe(17);
  });
  it('maps an unknown label to the default index', () => {
    expect(divisionLabelToIndex('bogus')).toBe(LFO_SYNC_DEFAULT_INDEX);
  });
});
