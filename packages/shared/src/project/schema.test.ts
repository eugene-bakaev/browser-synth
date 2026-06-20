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
      } else if (d.kind === 'enum') {
        // Enum descriptors map to z.enum(values) — each declared value is valid,
        // numbers and undeclared strings are rejected.
        for (const v of d.enumValues!) {
          expect(leaf.safeParse(v).success, `${d.key}=${v}`).toBe(true);
        }
        expect(leaf.safeParse(0).success, d.key).toBe(false);
        expect(leaf.safeParse('__invalid__').success, d.key).toBe(false);
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

  it('accepts an env3 ADSR + loop and the env1/env2 loop booleans (I3c)', () => {
    const base = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    base.env3 = { a: 1, d: 2, s: 0.3, r: 1.5, loop: true };
    base.env1.loop = true;
    base.env2.loop = false;
    expect(() => Schemas.Synth2Params.parse(base)).not.toThrow();
  });

  it('rejects a non-boolean env loop and an out-of-range env3 time (I3c)', () => {
    const bad1 = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    bad1.env1.loop = 1; // number, not boolean
    expect(() => Schemas.Synth2Params.parse(bad1)).toThrow();
    const bad2 = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    bad2.env3.a = 999; // > max 10
    expect(() => Schemas.Synth2Params.parse(bad2)).toThrow();
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

describe('synth2 matrix schema (I3a)', () => {
  const base = () => structuredClone(DEFAULT_SYNTH2_PARAMS);

  it('accepts the default 8-slot matrix', () => {
    expect(Schemas.Synth2Params.safeParse(base()).success).toBe(true);
  });

  it('accepts a valid route', () => {
    const p = base();
    p.matrix[0] = { source: 'env1', dest: 'filter.cutoff', amount: 0.5 };
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(true);
  });

  it('rejects an unknown source', () => {
    const p = base();
    (p.matrix[0] as { source: string }).source = 'lfo9';
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(false);
  });

  it('rejects a non-modulatable dest', () => {
    const p = base();
    // filter.type is excluded because it is an enum kind (not continuous).
    (p.matrix[0] as { dest: string }).dest = 'filter.type';
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(false);
    // filter.envAmount is excluded for a different reason: continuous but modulatable:false.
    (p.matrix[0] as { dest: string }).dest = 'filter.envAmount';
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(false);
  });

  it('accepts amount at the inclusive ±1 boundary', () => {
    const p = base();
    p.matrix[0] = { source: 'env1', dest: 'filter.cutoff', amount: 1 };
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(true);
    p.matrix[0].amount = -1;
    expect(Schemas.Synth2Params.safeParse(p).success).toBe(true);
  });

  it('rejects amount outside [-1, 1] and a wrong slot count', () => {
    const over = base(); over.matrix[0].amount = 1.5;
    expect(Schemas.Synth2Params.safeParse(over).success).toBe(false);
    const short = base(); short.matrix = short.matrix.slice(0, 7);
    expect(Schemas.Synth2Params.safeParse(short).success).toBe(false);
  });
});

describe('synth2 LFO leaf schemas (I3b)', () => {
  it('generates lfo rate/shape leaf schemas from the descriptor table', () => {
    expect(SYNTH2_LEAF_SCHEMAS['lfo1.rate'].safeParse(5).success).toBe(true);
    expect(SYNTH2_LEAF_SCHEMAS['lfo1.rate'].safeParse(0).success).toBe(false);     // < 0.01
    expect(SYNTH2_LEAF_SCHEMAS['lfo1.rate'].safeParse(2001).success).toBe(false);  // > 2000
    expect(SYNTH2_LEAF_SCHEMAS['lfo2.shape'].safeParse(0).success).toBe(true);
    expect(SYNTH2_LEAF_SCHEMAS['lfo2.shape'].safeParse(4).success).toBe(true);
    expect(SYNTH2_LEAF_SCHEMAS['lfo2.shape'].safeParse(4.1).success).toBe(false);  // > 4
  });
});

describe('synth2 enum (filter.type) leaf', () => {
  it('maps filter.type to a string-enum leaf schema', () => {
    const leaf = SYNTH2_LEAF_SCHEMAS['filter.type'];
    expect(leaf.safeParse('lp').success).toBe(true);
    expect(leaf.safeParse('bp').success).toBe(true);
    expect(leaf.safeParse('hp').success).toBe(true);
    expect(leaf.safeParse('xyz').success).toBe(false);
    expect(leaf.safeParse(0).success).toBe(false);
  });

  it('keeps filter.cutoff a clamped numeric leaf', () => {
    const leaf = SYNTH2_LEAF_SCHEMAS['filter.cutoff'];
    expect(leaf.safeParse(2000).success).toBe(true);
    expect(leaf.safeParse(99999).success).toBe(false);
  });

  it('Synth2ParamsSchema requires a well-formed filter module', () => {
    // `.shape.filter` is a dynamically-built key not statically typed, so cast.
    const filterSchema = (Schemas.Synth2Params.shape as any).filter;
    const ok = filterSchema.safeParse({
      cutoff: 2000, resonance: 0.15, keyTrack: 0, envAmount: 2.4, type: 'lp', morph: 0, model: 'classic', drive: 0,
    });
    expect(ok.success).toBe(true);
    const bad = filterSchema.safeParse({
      cutoff: 2000, resonance: 0.15, keyTrack: 0, envAmount: 2.4, type: 'moog', morph: 0, model: 'classic', drive: 0,
    });
    expect(bad.success).toBe(false);
  });
});

describe('synth2 morph filter schema (I3d)', () => {
  it('accepts filter.morph in range and filter.model classic/morph', () => {
    const p = structuredClone(DEFAULT_SYNTH2_PARAMS);
    p.filter.morph = 2; p.filter.model = 'morph';
    expect(() => Schemas.Synth2Params.parse(p)).not.toThrow();
  });

  it('rejects out-of-range filter.morph and unknown filter.model', () => {
    const p1 = structuredClone(DEFAULT_SYNTH2_PARAMS); (p1.filter as any).morph = 3;
    expect(() => Schemas.Synth2Params.parse(p1)).toThrow();
    const p2 = structuredClone(DEFAULT_SYNTH2_PARAMS); (p2.filter as any).model = 'lp';
    expect(() => Schemas.Synth2Params.parse(p2)).toThrow();
  });
});
