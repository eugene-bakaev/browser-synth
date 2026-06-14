import { describe, it, expect } from 'vitest';
import { freshProject } from './factory.js';
import { ProjectSchema, Schemas, SYNTH2_LEAF_SCHEMAS } from './schema.js';
import { SYNTH2_DESCRIPTORS, DEFAULT_SYNTH2_PARAMS } from '../engines/index.js';

describe('ProjectSchema', () => {
  it('accepts freshProject()', () => {
    const result = ProjectSchema.safeParse(freshProject());
    if (!result.success) {
      // Surface the first issue so a future shape drift is easy to debug.
      // eslint-disable-next-line no-console
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it('rejects bpm out of range', () => {
    const p = freshProject();
    p.bpm = 999;
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });

  it('rejects wrong number of tracks', () => {
    const p = freshProject();
    // Cast through unknown so we can land an off-tuple shape for the test.
    const broken = { ...p, tracks: p.tracks.slice(0, 3) } as unknown;
    expect(ProjectSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects unknown engineType', () => {
    const p = freshProject();
    const broken = {
      ...p,
      tracks: [
        { ...p.tracks[0], engineType: 'theremin' },
        p.tracks[1],
        p.tracks[2],
        p.tracks[3],
      ],
    } as unknown;
    expect(ProjectSchema.safeParse(broken).success).toBe(false);
  });

  it('parses a fresh v2 project with 64-step buffers and patternLength', () => {
    const p = freshProject();
    expect(p.schemaVersion).toBe(2);
    expect(p.tracks[0].steps).toHaveLength(64);
    expect(p.tracks[0].patternLength).toBe(16);
    expect(Schemas.Project.safeParse(p).success).toBe(true);
  });

  it('rejects a project whose steps buffer is not exactly 64', () => {
    const p = freshProject();
    p.tracks[0].steps = p.tracks[0].steps.slice(0, 16);
    expect(Schemas.Project.safeParse(p).success).toBe(false);
  });

  it('rejects a patternLength outside 1..64', () => {
    const p = freshProject();
    p.tracks[0].patternLength = 65;
    expect(Schemas.Project.safeParse(p).success).toBe(false);
    // Lower bound matters too: patternLength 0 would cause modulo-by-zero at playback.
    p.tracks[0].patternLength = 0;
    expect(Schemas.Project.safeParse(p).success).toBe(false);
  });
});

describe('variable track pool schema', () => {
  it('accepts a freshProject (32 slots, each with enabled)', () => {
    expect(ProjectSchema.safeParse(freshProject()).success).toBe(true);
  });

  it('rejects a project with the old length of 4', () => {
    const p = freshProject();
    p.tracks = p.tracks.slice(0, 4);
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a track missing enabled', () => {
    const p = freshProject();
    delete (p.tracks[0] as { enabled?: boolean }).enabled;
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });

  it('TrackSchema.enabled validates a boolean leaf', () => {
    expect(Schemas.Track.shape.enabled.safeParse(true).success).toBe(true);
    expect(Schemas.Track.shape.enabled.safeParse('yes').success).toBe(false);
  });
});

describe('synth2 schema (generated from descriptors)', () => {
  it('accepts the defaults', () => {
    expect(Schemas.Synth2Params.safeParse(DEFAULT_SYNTH2_PARAMS).success).toBe(true);
  });

  it('rejects out-of-range and missing leaves', () => {
    const bad = structuredClone(DEFAULT_SYNTH2_PARAMS);
    bad.osc1.morph = 99;
    expect(Schemas.Synth2Params.safeParse(bad).success).toBe(false);
    const missing = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    delete missing.env1.r;
    expect(Schemas.Synth2Params.safeParse(missing).success).toBe(false);
  });

  it('has one leaf validator per descriptor, enforcing the descriptor range', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const leaf = SYNTH2_LEAF_SCHEMAS[d.key];
      expect(leaf, d.key).toBeDefined();
      if (d.kind === 'bool') {
        // Bool descriptors map to z.boolean() — number inputs are rejected.
        expect(leaf.safeParse(true).success, d.key).toBe(true);
        expect(leaf.safeParse(false).success, d.key).toBe(true);
        expect(leaf.safeParse(0).success, d.key).toBe(false);
        expect(leaf.safeParse(1).success, d.key).toBe(false);
      } else {
        expect(leaf.safeParse(d.min).success, d.key).toBe(true);
        expect(leaf.safeParse(d.max).success, d.key).toBe(true);
        expect(leaf.safeParse(d.min - 1e-6).success, d.key).toBe(false);
        expect(leaf.safeParse(d.max + 1e-6).success, d.key).toBe(false);
      }
    }
  });

  it('accepts mono and poly mode and rejects anything else', () => {
    const ok = { ...DEFAULT_SYNTH2_PARAMS, mode: 'poly' as const };
    expect(Schemas.Synth2Params.safeParse(ok).success).toBe(true);
    const bad = { ...DEFAULT_SYNTH2_PARAMS, mode: 'chord' };
    expect(Schemas.Synth2Params.safeParse(bad).success).toBe(false);
  });
});

describe('synth2 discrete (bool) leaves', () => {
  it('maps osc.sync to a boolean leaf schema', () => {
    for (const key of ['osc1.sync', 'osc2.sync', 'osc3.sync']) {
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse(true).success, key).toBe(true);
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse(false).success, key).toBe(true);
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse(1).success, key).toBe(false);
      expect(SYNTH2_LEAF_SCHEMAS[key].safeParse('x').success, key).toBe(false);
    }
  });

  it('Synth2ParamsSchema requires osc.sync to be boolean', () => {
    // Validate via the full schema — .shape.osc2 is a dynamic key not statically
    // typed by TypeScript, so we use structuredClone + field override instead.
    const withSyncTrue = structuredClone(DEFAULT_SYNTH2_PARAMS);
    withSyncTrue.osc2.sync = true;
    expect(Schemas.Synth2Params.safeParse(withSyncTrue).success).toBe(true);

    const withSyncNumber = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    withSyncNumber.osc2.sync = 1;
    expect(Schemas.Synth2Params.safeParse(withSyncNumber).success).toBe(false);
  });
});
