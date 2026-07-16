import { describe, it, expect } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { orderedEnabledEntries } from './trackEntries';

describe('orderedEnabledEntries', () => {
  it('identity order: enabled slots in pool order with sequential displayPos', () => {
    const p = freshProject(); // 4 enabled by default
    const entries = orderedEnabledEntries(p);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(entries.map((e) => e.displayPos)).toEqual([0, 1, 2, 3]);
  });
  it('follows trackOrder and skips disabled slots', () => {
    const p = freshProject();
    p.trackOrder = [2, 5, 0, ...p.trackOrder.filter((i) => ![2, 5, 0].includes(i))];
    const entries = orderedEnabledEntries(p); // slot 5 is disabled by default
    expect(entries.map((e) => e.index)).toEqual([2, 0, 1, 3]);
    expect(entries.map((e) => e.displayPos)).toEqual([0, 1, 2, 3]);
    expect(entries[0].track).toBe(p.tracks[2]);
  });
});
