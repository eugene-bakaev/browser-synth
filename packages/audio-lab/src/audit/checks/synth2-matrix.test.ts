// Gate-run exhaustiveness tests for the full synth2 mod matrix (Task 10). No
// renders here — this file must stay fast and kernel-free so it runs in the
// normal `npm test` gate, not just under `npm run lab:audit`. It exists so
// appending a new MOD_DEST without classifying it into DEST_FAMILY fails
// immediately, rather than silently rendering as health-only forever.
import { describe, expect, it } from 'vitest';
import { MOD_DESTS, MOD_SOURCES } from '@fiddle/shared';
import { DEST_FAMILY, EXPECTED_INERT, synth2MatrixChecks } from './synth2-matrix';

describe('synth2 matrix coverage', () => {
  it('every MOD_DEST is classified into exactly one family (appending a dest without classifying it fails here)', () => {
    for (const dest of MOD_DESTS) {
      if (dest === 'none') continue;
      expect(DEST_FAMILY[dest], `unclassified mod dest '${dest}'`).toBeDefined();
    }
    for (const key of Object.keys(DEST_FAMILY)) {
      expect(MOD_DESTS).toContain(key); // no stale entries either
    }
  });
  it('full mode emits one check per source x dest cell', () => {
    expect(synth2MatrixChecks(false)).toHaveLength(MOD_SOURCES.length * MOD_DESTS.length);
  });
  it('fast mode is a strict, much smaller subset', () => {
    const full = new Set(synth2MatrixChecks(false).map((c) => c.id));
    const fast = synth2MatrixChecks(true);
    expect(fast.length).toBeLessThan(80);
    for (const c of fast) expect(full).toContain(c.id);
  });
  it('EXPECTED_INERT only names real cells, with reasons in the source', () => {
    for (const [s, d] of EXPECTED_INERT) {
      expect(MOD_SOURCES).toContain(s);
      expect(MOD_DESTS).toContain(d);
    }
  });
});
