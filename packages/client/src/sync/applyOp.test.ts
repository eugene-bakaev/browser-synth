import { describe, it, expect, beforeEach } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { applyOp, isApplyingFromNetwork, resetApplyOpState } from './applyOp.js';

describe('applyOp', () => {
  beforeEach(() => resetApplyOpState());

  it('applies a bpm set', () => {
    const p = freshProject();
    const ok = applyOp(p, { v:1, type:'set', opId: 1, clientId:'x', path:['bpm'], value: 140 });
    expect(ok).toBe(true);
    expect(p.bpm).toBe(140);
  });

  it('applies a deep nested set', () => {
    const p = freshProject();
    applyOp(p, { v:1, type:'set', opId: 1, clientId:'x',
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: 800 });
    expect(p.tracks[0].engines.synth.filterCutoff).toBe(800);
  });

  it('ignores stale opIds for the same path', () => {
    const p = freshProject();
    applyOp(p, { v:1, type:'set', opId: 5, clientId:'x', path:['bpm'], value: 150 });
    const ok = applyOp(p, { v:1, type:'set', opId: 3, clientId:'x', path:['bpm'], value: 130 });
    expect(ok).toBe(false);
    expect(p.bpm).toBe(150);
  });

  it('sets and resets the suppression flag', () => {
    const p = freshProject();
    expect(isApplyingFromNetwork()).toBe(false);
    applyOp(p, { v:1, type:'set', opId: 1, clientId:'x', path:['bpm'], value: 140 });
    expect(isApplyingFromNetwork()).toBe(false); // reset by finally
  });
});
