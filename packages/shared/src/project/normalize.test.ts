import { describe, it, expect } from 'vitest';
import { normalizeProject, coerceBpm } from './normalize.js';
import { freshProject, freshTrack, TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './factory.js';
import { DEFAULT_BPM, BPM_MIN, BPM_MAX } from './constants.js';
import { ProjectSchema } from './schema.js';
import { PROJECT_SCHEMA_VERSION } from '../index.js';
import type { Project } from './types.js';

describe('normalizeProject', () => {
  it('pads a legacy 4-track project to TRACK_POOL_SIZE slots', () => {
    const legacy = {
      schemaVersion: 2,
      bpm: 128,
      tracks: Array.from({ length: 4 }, () => freshTrack(true)),
    } as unknown as Project;
    // simulate legacy: no enabled field at all
    legacy.tracks.forEach(t => delete (t as { enabled?: boolean }).enabled);

    const out = normalizeProject(legacy);
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
    const out = normalizeProject(p);
    expect(out.tracks.slice(0, 4).map(t => t.enabled)).toEqual([true, false, true, true]);
  });

  it('is idempotent on an already-normalized project (returns it unchanged)', () => {
    const p = freshProject();
    expect(normalizeProject(p)).toBe(p);
  });

  it('coerces a non-boolean enabled (corrupt/legacy data) to true and rebuilds', () => {
    const p = freshProject();
    // A full 32-slot project whose enabled was deserialized as a non-boolean.
    (p.tracks[5] as { enabled: unknown }).enabled = 'yes';

    const out = normalizeProject(p);
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

    const out = normalizeProject(broken);
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

    const out = normalizeProject(p);
    expect(out).not.toBe(p);
    expect(out.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    // Enabled set is preserved (already valid count), not re-healed.
    expect(out.tracks.filter(t => t.enabled)).toHaveLength(DEFAULT_ENABLED_TRACKS);
  });

  // --- bpm repair ----------------------------------------------------------
  // The bug this guards: a project with a well-formed track pool but a
  // blank/garbage bpm used to take the fast path and pass through unchanged,
  // leaving the transport field blank.

  // Build an otherwise-valid 32-slot project, then poke bpm to an invalid value.
  function projectWithBpm(bpm: unknown): Project {
    const p = freshProject();
    (p as { bpm: unknown }).bpm = bpm;
    return p;
  }

  it('defaults a missing/undefined bpm to DEFAULT_BPM (and rebuilds — not fast path)', () => {
    const p = projectWithBpm(undefined);
    const out = normalizeProject(p);
    expect(out).not.toBe(p);
    expect(out.bpm).toBe(DEFAULT_BPM);
  });

  it.each([
    ['NaN', NaN],
    ['a string', '128'],
    ['null', null],
    ['zero', 0],
    ['negative', -50],
  ])('defaults a non-finite/non-number bpm (%s) to DEFAULT_BPM', (_label, bad) => {
    // 0 and -50 are finite numbers but out of range; they clamp to BPM_MIN
    // rather than DEFAULT_BPM. Assert per case.
    const out = normalizeProject(projectWithBpm(bad));
    if (typeof bad === 'number' && Number.isFinite(bad)) {
      expect(out.bpm).toBe(BPM_MIN);
    } else {
      expect(out.bpm).toBe(DEFAULT_BPM);
    }
  });

  it('clamps an out-of-range bpm into [BPM_MIN, BPM_MAX]', () => {
    expect(normalizeProject(projectWithBpm(5000)).bpm).toBe(BPM_MAX);
    expect(normalizeProject(projectWithBpm(10)).bpm).toBe(BPM_MIN);
  });

  it('rounds a non-integer bpm to the nearest integer', () => {
    expect(normalizeProject(projectWithBpm(128.7)).bpm).toBe(129);
  });

  it('preserves a valid bpm via the fast path (returns input by reference)', () => {
    const p = freshProject();
    p.bpm = 140;
    expect(normalizeProject(p)).toBe(p);
  });

  // --- schema oracle -------------------------------------------------------
  // This is the anti-fishnet guard: the normalizer's top-level scalar output
  // must satisfy the canonical ProjectSchema. If a future top-level scalar is
  // added to ProjectSchema but the normalizer isn't taught to default it, this
  // fails — instead of the field silently leaking undefined through a load.
  it('output top-level scalars always satisfy ProjectSchema', () => {
    const TopLevelScalars = ProjectSchema.pick({ schemaVersion: true, bpm: true });
    const malformed: unknown[] = [
      { bpm: undefined, tracks: [] },
      { bpm: NaN, tracks: Array.from({ length: TRACK_POOL_SIZE }, () => freshTrack(true)) },
      { bpm: 5000, tracks: Array.from({ length: 4 }, () => freshTrack(true)) },
      { tracks: [] }, // missing bpm AND schemaVersion
      { schemaVersion: 1, bpm: '120', tracks: [] },
    ];
    for (const input of malformed) {
      const out = normalizeProject(input as Project);
      expect(TopLevelScalars.safeParse(out).success).toBe(true);
    }
  });
});

describe('coerceBpm', () => {
  it('returns DEFAULT_BPM for non-finite / non-number values', () => {
    expect(coerceBpm(undefined)).toBe(DEFAULT_BPM);
    expect(coerceBpm(null)).toBe(DEFAULT_BPM);
    expect(coerceBpm(NaN)).toBe(DEFAULT_BPM);
    expect(coerceBpm('128')).toBe(DEFAULT_BPM);
  });

  it('rounds and clamps finite numbers into [BPM_MIN, BPM_MAX]', () => {
    expect(coerceBpm(128.7)).toBe(129);
    expect(coerceBpm(5000)).toBe(BPM_MAX);
    expect(coerceBpm(0)).toBe(BPM_MIN);
    expect(coerceBpm(140)).toBe(140);
  });
});
