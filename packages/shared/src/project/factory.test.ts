import { describe, it, expect } from 'vitest';
import { freshProject, freshTrack, TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './factory.js';
import { DEFAULT_SYNTH2_PARAMS } from '../engines/index.js';
import { identityTrackOrder } from './order.js';

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

it('freshTrack carries an independent synth2 slice at defaults', () => {
  const t = freshTrack();
  expect(t.engines.synth2).toEqual(DEFAULT_SYNTH2_PARAMS);
  expect(t.engines.synth2).not.toBe(DEFAULT_SYNTH2_PARAMS); // structuredClone, D7
});

it('fresh tracks are unnamed (name is the empty string)', () => {
  expect(freshTrack().name).toBe('');
});

it('freshProject carries the identity trackOrder', () => {
  expect(freshProject().trackOrder).toEqual(identityTrackOrder());
});
