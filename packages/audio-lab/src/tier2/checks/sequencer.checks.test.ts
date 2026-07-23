import { describe, it, expect } from 'vitest';
import { buildSequencerFixture } from '../fixtures/sequencerFixture';
import { expectedOnsets } from './sequencer.checks';

describe('expectedOnsets', () => {
  const p = buildSequencerFixture(); // bpm 120 → tick 0.125s
  it('four-on-the-floor over 2 bars (track 0)', () => {
    expect(expectedOnsets(p, 2, 0)).toEqual([0, 4, 8, 12, 16, 20, 24, 28].map((k) => k * 0.125));
  });
  it('polymeter track wraps at patternLength 12 (track 2), 3 bars', () => {
    expect(expectedOnsets(p, 3, 2)).toEqual([0, 12, 24, 36].map((k) => k * 0.125));
  });
});
