import { describe, it, expect } from 'vitest';
import { deepEqual, packProject } from './snapshot-codec.js';
import { freshProject, freshTrack } from './factory.js';

describe('deepEqual', () => {
  it('is true for identical primitives and structurally equal objects', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual({ x: 1, y: [2, 3] }, { x: 1, y: [2, 3] })).toBe(true);
  });

  it('is insensitive to key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('is false for differing values, lengths, or key sets', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
    expect(deepEqual({ a: 1 }, null)).toBe(false);
  });
});

describe('packProject', () => {
  it('keeps only the enabled slots for a default project', () => {
    const packed = packProject(freshProject()); // 4 enabled, 28 pristine padding
    expect(Object.keys(packed.tracks).sort()).toEqual(['0', '1', '2', '3']);
    expect(packed.bpm).toBe(120);
    expect(packed.schemaVersion).toBe(2);
  });

  it('keeps a disabled-but-edited slot (differs from fresh)', () => {
    const p = freshProject();
    p.tracks[10] = freshTrack(false);     // disabled padding...
    p.tracks[10].steps[0].note = 'C';     // ...but edited -> carries information
    const packed = packProject(p);
    expect(Object.keys(packed.tracks)).toContain('10');
  });

  it('keeps all slots when all are enabled', () => {
    const p = freshProject();
    p.tracks.forEach((t) => { t.enabled = true; });
    expect(Object.keys(packProject(p).tracks)).toHaveLength(32);
  });

  it('keeps an enabled-but-pristine slot (enabled wins)', () => {
    const p = freshProject();
    p.tracks[7] = freshTrack(true); // enabled, otherwise identical to fresh
    expect(Object.keys(packProject(p).tracks)).toContain('7');
  });
});
