import { describe, it, expect } from 'vitest';
import { freshProject } from './factory.js';
import { ProjectSchema, Schemas } from './schema.js';

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
