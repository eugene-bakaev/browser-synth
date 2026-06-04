import { describe, it, expect } from 'vitest';
import { normalizeTrackPool } from './normalize.js';
import { freshProject, freshTrack, TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './factory.js';
import { PROJECT_SCHEMA_VERSION } from '../index.js';
import type { Project } from './types.js';

describe('normalizeTrackPool', () => {
  it('pads a legacy 4-track project to TRACK_POOL_SIZE slots', () => {
    const legacy = {
      schemaVersion: 2,
      bpm: 128,
      tracks: Array.from({ length: 4 }, () => freshTrack(true)),
    } as unknown as Project;
    // simulate legacy: no enabled field at all
    legacy.tracks.forEach(t => delete (t as { enabled?: boolean }).enabled);

    const out = normalizeTrackPool(legacy);
    expect(out.tracks).toHaveLength(TRACK_POOL_SIZE);
    // original 4 default to enabled
    expect(out.tracks.slice(0, 4).every(t => t.enabled)).toBe(true);
    // padded slots are disabled
    expect(out.tracks.slice(4).every(t => t.enabled === false)).toBe(true);
    // unrelated fields preserved
    expect(out.bpm).toBe(128);
  });

  it('preserves an explicit enabled value on existing slots', () => {
    const p = {
      schemaVersion: 2,
      bpm: 120,
      tracks: [freshTrack(true), freshTrack(false), freshTrack(true), freshTrack(true)],
    } as unknown as Project;
    const out = normalizeTrackPool(p);
    expect(out.tracks.slice(0, 4).map(t => t.enabled)).toEqual([true, false, true, true]);
  });

  it('is idempotent on an already-normalized project (returns it unchanged)', () => {
    const p = freshProject();
    expect(normalizeTrackPool(p)).toBe(p);
  });

  it('coerces a non-boolean enabled (corrupt/legacy data) to true and rebuilds', () => {
    const p = freshProject();
    // A full 32-slot project whose enabled was deserialized as a non-boolean.
    (p.tracks[5] as { enabled: unknown }).enabled = 'yes';

    const out = normalizeTrackPool(p);
    // The non-boolean slot fails the fast-path check, so a rebuilt copy is returned.
    expect(out).not.toBe(p);
    expect(out.tracks).toHaveLength(TRACK_POOL_SIZE);
    expect(out.tracks[5].enabled).toBe(true);
  });

  it('heals a 32-slot, all-disabled project (no enabled tracks) back to the default count', () => {
    // Reproduces the "test 222" corruption: a full 32-slot pool with every slot
    // disabled and no schemaVersion. The UI enforces >=1 track, so 0 enabled is
    // always corruption — normalize must restore the default enabled count.
    const broken = {
      bpm: 120,
      tracks: Array.from({ length: TRACK_POOL_SIZE }, () => freshTrack(false)),
    } as unknown as Project;
    delete (broken as { schemaVersion?: number }).schemaVersion;

    const out = normalizeTrackPool(broken);
    expect(out.tracks).toHaveLength(TRACK_POOL_SIZE);
    expect(out.tracks.filter(t => t.enabled)).toHaveLength(DEFAULT_ENABLED_TRACKS);
    // First DEFAULT_ENABLED_TRACKS slots are the ones re-enabled.
    expect(out.tracks.slice(0, DEFAULT_ENABLED_TRACKS).every(t => t.enabled)).toBe(true);
    expect(out.tracks.slice(DEFAULT_ENABLED_TRACKS).every(t => t.enabled === false)).toBe(true);
    expect(out.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('always stamps the current schemaVersion (even on an otherwise-valid pool)', () => {
    // 32 slots, boolean enabled, >=1 enabled, but schemaVersion missing → must
    // be rebuilt with the version stamped.
    const p = {
      bpm: 120,
      tracks: Array.from({ length: TRACK_POOL_SIZE }, (_, i) => freshTrack(i < DEFAULT_ENABLED_TRACKS)),
    } as unknown as Project;
    delete (p as { schemaVersion?: number }).schemaVersion;

    const out = normalizeTrackPool(p);
    expect(out).not.toBe(p);
    expect(out.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    // Enabled set is preserved (already valid count), not re-healed.
    expect(out.tracks.filter(t => t.enabled)).toHaveLength(DEFAULT_ENABLED_TRACKS);
  });
});
