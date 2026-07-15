import { describe, it, expect } from 'vitest';
import { deepEqual, packProject, unpackProject } from './snapshot-codec.js';
import { freshProject, freshTrack } from './factory.js';
import { normalizeProject, identityTrackOrder } from './index.js';

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

describe('unpackProject', () => {
  it('round-trips a default project (unpack(pack(p)) == normalizeProject(p))', () => {
    const p = freshProject();
    expect(unpackProject(packProject(p))).toEqual(normalizeProject(p));
  });

  it('round-trips a disabled-but-edited slot losslessly', () => {
    const p = freshProject();
    p.tracks[10] = freshTrack(false);
    p.tracks[10].steps[0].note = 'C';
    const out = unpackProject(packProject(p));
    expect(out.tracks[10].steps[0].note).toBe('C');
    expect(out.tracks[10].enabled).toBe(false);
  });

  it('reads the legacy full-array form unchanged', () => {
    const legacy = freshProject(); // tracks is a 32-element ARRAY
    legacy.tracks[0].steps[3].note = 'E';
    const out = unpackProject(legacy);
    expect(out.tracks).toHaveLength(32);
    expect(out.tracks[0].steps[3].note).toBe('E');
  });

  it('fills omitted indices with disabled fresh tracks', () => {
    const out = unpackProject(packProject(freshProject()));
    expect(out.tracks).toHaveLength(32);
    expect(out.tracks[20].enabled).toBe(false); // a padding slot
  });

  it('heals garbage defensively without throwing', () => {
    for (const bad of [null, undefined, 'nope', 42, {}, { tracks: 5 }]) {
      const out = unpackProject(bad);
      expect(out.tracks).toHaveLength(32);
      expect(out.tracks.some((t) => t.enabled)).toBe(true); // normalizeProject re-enables
      expect(out.schemaVersion).toBe(2);
    }
  });
});

describe('trackOrder round-trip', () => {
  it('pack keeps the order; unpack restores it', () => {
    const p = normalizeProject(freshProject());
    p.trackOrder = [...p.trackOrder].reverse();
    const stored = packProject(p);
    expect(stored.trackOrder).toEqual(p.trackOrder);
    expect(unpackProject(stored).trackOrder).toEqual(p.trackOrder);
  });
  it('legacy stored rows without trackOrder unpack to identity', () => {
    const stored = packProject(normalizeProject(freshProject())) as Record<string, unknown>;
    delete stored.trackOrder;
    expect(unpackProject(stored).trackOrder).toEqual(identityTrackOrder());
  });
});
