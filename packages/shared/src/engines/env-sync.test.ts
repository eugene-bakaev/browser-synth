import { describe, it, expect } from 'vitest';
import {
  ENV_SYNC_DIVISIONS, ENV_SYNC_LABELS, ENV_SYNC_KNOB_LABELS, ENV_SYNC_DEFAULT_LABEL,
  ENV_SYNC_DEFAULT_INDEX, envDivisionToSeconds, envDivisionLabelToIndex,
} from './env-sync.js';

describe('ENV_SYNC_DIVISIONS', () => {
  it('is exactly the 19 step divisions, shortest → longest', () => {
    expect(ENV_SYNC_LABELS).toEqual([
      '1/16', '1/8', '1/6', '1/4', '1/3', '1/2', '2/3', '3/4',
      '1', '1.5', '2', '3', '4', '6', '8', '12', '16', '24', '32',
    ]);
    // Strictly increasing steps guards the knob sweep direction: right = longer,
    // matching the free-mode seconds knobs the synced knobs replace.
    for (let i = 1; i < ENV_SYNC_DIVISIONS.length; i++) {
      expect(ENV_SYNC_DIVISIONS[i].steps).toBeGreaterThan(ENV_SYNC_DIVISIONS[i - 1].steps);
    }
  });

  it('knob labels carry the step unit', () => {
    expect(ENV_SYNC_KNOB_LABELS).toEqual(ENV_SYNC_LABELS.map(l => `${l} st`));
    expect(ENV_SYNC_KNOB_LABELS[ENV_SYNC_DEFAULT_INDEX]).toBe('1 st');
  });

  it('defaults to one step', () => {
    expect(ENV_SYNC_DEFAULT_LABEL).toBe('1');
    expect(ENV_SYNC_DEFAULT_INDEX).toBe(ENV_SYNC_LABELS.indexOf('1'));
    expect(ENV_SYNC_DIVISIONS[ENV_SYNC_DEFAULT_INDEX].steps).toBe(1);
  });
});

describe('envDivisionToSeconds', () => {
  it('derives seconds = steps × 15 / bpm', () => {
    expect(envDivisionToSeconds('1', 120)).toBeCloseTo(0.125, 10);      // one step @120
    expect(envDivisionToSeconds('4', 120)).toBeCloseTo(0.5, 10);        // = old 1/4-note default
    expect(envDivisionToSeconds('1/2', 120)).toBeCloseTo(0.0625, 10);   // = old 1/32-note default
    expect(envDivisionToSeconds('1/16', 120)).toBeCloseTo(0.0078125, 10);
    expect(envDivisionToSeconds('32', 40)).toBeCloseTo(12, 10);         // pre-clamp slow extreme
  });

  it('matches steps × 15 / bpm for every entry', () => {
    for (const d of ENV_SYNC_DIVISIONS) {
      expect(envDivisionToSeconds(d.label, 97)).toBeCloseTo((d.steps * 15) / 97, 10);
    }
  });

  it('falls back to one step for an unknown label (never NaN)', () => {
    expect(envDivisionToSeconds('1/32T', 120)).toBeCloseTo(0.125, 10); // legacy note label
    expect(envDivisionToSeconds('bogus', 120)).toBeCloseTo(0.125, 10);
  });
});

describe('envDivisionLabelToIndex', () => {
  it('maps labels to their index', () => {
    expect(envDivisionLabelToIndex('1/16')).toBe(0);
    expect(envDivisionLabelToIndex('32')).toBe(18);
  });
  it('maps an unknown label to the default index', () => {
    expect(envDivisionLabelToIndex('1/32.')).toBe(ENV_SYNC_DEFAULT_INDEX); // legacy note label
    expect(envDivisionLabelToIndex('bogus')).toBe(ENV_SYNC_DEFAULT_INDEX);
  });
});
