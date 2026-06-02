import { describe, it, expect } from 'vitest';
import { freshProject, freshTrack, TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './factory.js';

describe('freshProject track pool', () => {
  it('returns exactly TRACK_POOL_SIZE slots', () => {
    expect(freshProject().tracks).toHaveLength(TRACK_POOL_SIZE);
  });

  it('enables exactly the first DEFAULT_ENABLED_TRACKS slots', () => {
    const enabled = freshProject().tracks.map(t => t.enabled);
    const expected = Array.from({ length: TRACK_POOL_SIZE }, (_, i) => i < DEFAULT_ENABLED_TRACKS);
    expect(enabled).toEqual(expected);
  });

  it('TRACK_POOL_SIZE is 32 and DEFAULT_ENABLED_TRACKS is 4', () => {
    expect(TRACK_POOL_SIZE).toBe(32);
    expect(DEFAULT_ENABLED_TRACKS).toBe(4);
  });

  it('freshTrack(false) is disabled, freshTrack() defaults to enabled', () => {
    expect(freshTrack(false).enabled).toBe(false);
    expect(freshTrack().enabled).toBe(true);
  });
});
