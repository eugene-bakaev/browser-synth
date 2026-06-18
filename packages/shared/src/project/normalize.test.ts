import { describe, it, expect } from 'vitest';
import { normalizeProject, coerceBpm } from './normalize.js';
import { freshProject, freshTrack, TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './factory.js';
import { DEFAULT_SYNTH2_PARAMS } from '../engines/index.js';
import {
  DEFAULT_BPM,
  BPM_MIN,
  BPM_MAX,
  STEP_BUFFER_SIZE,
  DEFAULT_PATTERN_LENGTH,
} from './constants.js';
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

  // --- deep track repair (D2) ----------------------------------------------
  // The bug this guards: the sync path (durable snapshot → wire → client)
  // never ran deep repair, so a legacy 16-step snapshot reached clients with
  // short step buffers, and a server-side op for steps.40 against a 16-element
  // array built a sparse array. normalizeProject is the single boundary both
  // directions share, so the structural invariants are enforced here.

  it('pads a legacy 16-step track to STEP_BUFFER_SIZE, preserving stored steps in place', () => {
    const p = freshProject();
    const stored = p.tracks[0].steps.slice(0, 16);
    stored[3] = { ...stored[3], note: 'C', velocity: 0.5 };
    (p.tracks[0] as { steps: unknown }).steps = stored;

    const out = normalizeProject(p);
    expect(out).not.toBe(p);
    expect(out.tracks[0].steps).toHaveLength(STEP_BUFFER_SIZE);
    expect(out.tracks[0].steps[3]).toMatchObject({ note: 'C', velocity: 0.5 }); // position kept
    expect(out.tracks[0].steps[40]).toMatchObject({ note: null }); // padding is fresh
    // Untouched tracks ride through by reference.
    expect(out.tracks[1]).toBe(p.tracks[1]);
  });

  it('fills holes in a sparse step buffer (setDeep on an out-of-range index)', () => {
    const p = freshProject();
    const sparse = p.tracks[2].steps.slice(0, 16);
    sparse[40] = { ...freshTrack().steps[0], note: 'E' }; // length 41, holes 16..39
    (p.tracks[2] as { steps: unknown }).steps = sparse;

    const out = normalizeProject(p);
    expect(out.tracks[2].steps).toHaveLength(STEP_BUFFER_SIZE);
    expect(out.tracks[2].steps[40]).toMatchObject({ note: 'E' });
    expect(out.tracks[2].steps[20]).toMatchObject({ note: null }); // hole filled
    expect(out.tracks[2].steps.every(s => typeof s === 'object' && s !== null)).toBe(true);
  });

  it('truncates an over-long step buffer to STEP_BUFFER_SIZE', () => {
    const p = freshProject();
    (p.tracks[0] as { steps: unknown }).steps = Array.from({ length: 100 }, () => freshTrack().steps[0]);
    expect(normalizeProject(p).tracks[0].steps).toHaveLength(STEP_BUFFER_SIZE);
  });

  it('fills a missing engine slice from defaults, keeping present slices by reference', () => {
    const p = freshProject();
    const kept = p.tracks[1].engines.kick;
    delete (p.tracks[1].engines as { synth?: unknown }).synth;

    const out = normalizeProject(p);
    expect(out.tracks[1].engines.synth).toBeDefined();
    expect(out.tracks[1].engines.kick).toBe(kept); // slice-level repair only
  });

  it('repairs a missing/garbage patternLength and clamps out-of-range values', () => {
    const p = freshProject();
    delete (p.tracks[0] as { patternLength?: unknown }).patternLength;
    (p.tracks[1] as { patternLength: unknown }).patternLength = 0;
    (p.tracks[2] as { patternLength: unknown }).patternLength = 999;

    const out = normalizeProject(p);
    expect(out.tracks[0].patternLength).toBe(DEFAULT_PATTERN_LENGTH);
    expect(out.tracks[1].patternLength).toBe(1);
    expect(out.tracks[2].patternLength).toBe(STEP_BUFFER_SIZE);
  });

  it('keeps the fast path: a structurally valid project is returned by reference', () => {
    const p = freshProject();
    p.tracks[0].steps[5].note = 'G';
    p.tracks[0].patternLength = 32;
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

describe('synth2 slice healing (old-snapshot regression — spec §7 item 7)', () => {
  it('fills a missing engines.synth2 from defaults and keeps other slices by reference', () => {
    const p = freshProject();
    delete (p.tracks[0].engines as any).synth2;
    const out = normalizeProject(p);
    expect(out).not.toBe(p); // fast path must NOT swallow the repair
    expect(out.tracks[0].engines.synth2).toEqual(DEFAULT_SYNTH2_PARAMS);
    expect(out.tracks[0].engines.synth).toBe(p.tracks[0].engines.synth);
    expect(out.tracks[1]).toBe(p.tracks[1]); // valid tracks ride through by reference
  });
});

// A present engine slice that is missing a PARAM LEAF (e.g. a session saved
// before a new descriptor was appended) must be deep-healed from defaults at
// this boundary — not just structurally accepted. Otherwise the missing leaf
// reaches the UI as `undefined` and crashes a panel that binds to it.
describe('engine param-leaf deep heal (old-snapshot regression — descriptor appends)', () => {
  it('fills a synth2.filter slice missing new leaves (morph/model), preserving present values', () => {
    const p = freshProject();
    const f = p.tracks[0].engines.synth2.filter as unknown as Record<string, unknown>;
    f.cutoff = 1234; // a present value that must survive the heal
    delete f.morph;
    delete f.model;

    const out = normalizeProject(p);
    expect(out).not.toBe(p); // an incomplete slice must NOT ride the fast path
    const healed = out.tracks[0].engines.synth2.filter;
    expect(healed.morph).toBe(DEFAULT_SYNTH2_PARAMS.filter.morph); // 0
    expect(healed.model).toBe(DEFAULT_SYNTH2_PARAMS.filter.model); // 'classic'
    expect(healed.cutoff).toBe(1234); // present value preserved
  });

  it('fills a missing nested envelope leaf without touching sibling values', () => {
    const p = freshProject();
    const env = p.tracks[2].engines.synth2.env3 as unknown as Record<string, unknown>;
    env.a = 0.42;
    delete env.s;

    const out = normalizeProject(p);
    expect(out.tracks[2].engines.synth2.env3.s).toBe(DEFAULT_SYNTH2_PARAMS.env3.s);
    expect(out.tracks[2].engines.synth2.env3.a).toBe(0.42); // sibling preserved
  });

  it('keeps a sibling complete slice by reference when another slice needs a leaf heal', () => {
    const p = freshProject();
    const keptKick = p.tracks[0].engines.kick;
    delete (p.tracks[0].engines.synth2.filter as unknown as Record<string, unknown>).morph;

    const out = normalizeProject(p);
    expect(out.tracks[0].engines.kick).toBe(keptKick); // complete slice unchanged
  });

  it('still fast-paths a fully-complete project by reference (deep check is not a false negative)', () => {
    const p = freshProject();
    expect(normalizeProject(p)).toBe(p);
  });

  it('produces a schema-valid project after a leaf heal', () => {
    const p = freshProject();
    const f = p.tracks[0].engines.synth2.filter as unknown as Record<string, unknown>;
    delete f.morph;
    delete f.model;
    const out = normalizeProject(p);
    expect(() => ProjectSchema.parse(out)).not.toThrow();
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
