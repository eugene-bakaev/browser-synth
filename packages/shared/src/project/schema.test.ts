import { describe, it, expect } from 'vitest';
import { freshProject } from './factory.js';
import { ProjectSchema } from './schema.js';

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
});
