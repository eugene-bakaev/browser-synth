// Gate-run, kernel-free honesty contract (Task 11): every descriptor key of
// every v2 engine must be either exercised by a check (Tasks 6-10) or
// declared a blind spot with a reason (blind-spots.ts). No renders here —
// this file only walks the check tables as DATA, so it stays fast enough for
// the normal `npm test` gate. Appending a descriptor row to any v2 engine
// without classifying it (check or blind spot) fails this file immediately.
import { describe, expect, it } from 'vitest';
import {
  SYNTH2_DESCRIPTORS, KICK2_DESCRIPTORS, SNARE2_DESCRIPTORS, HAT2_DESCRIPTORS, CLAP2_DESCRIPTORS,
} from '@fiddle/shared';
import type { CheckSpec } from '../types';
import { BLIND_SPOTS } from './blind-spots';
import { kick2Checks } from './kick2.checks';
import { snare2Checks } from './snare2.checks';
import { hat2Checks } from './hat2.checks';
import { clap2Checks } from './clap2.checks';
import { synth2Checks } from './synth2.checks';
import { synth2PerfChecks } from './synth2-perf.checks';
import { synth2MatrixChecks } from './synth2-matrix';

// A param counts as covered when a check moves it (directional/enum), routes
// to it (matrix dest), pins it in a baseline that an assertion depends on, or
// is a health-only check explicitly demoted FROM a directional/enum check for
// that param (osc1.sync.chg — a discovered no-op; see synth2.checks.ts).
export function coveredParams(checks: CheckSpec[]): Set<string> {
  const covered = new Set<string>();
  for (const c of checks) {
    const a = c.assertion;
    if (a.kind === 'directional' || a.kind === 'enum') covered.add(a.param);
    if (a.kind === 'route') covered.add(a.dest);
    if (a.kind === 'pitchSettle') covered.add('glide.time');
    if (a.kind === 'health' && a.param) covered.add(a.param);
    for (const r of c.baseline.matrix ?? []) covered.add(r.dest);
  }
  return covered;
}

const CASES: Array<[string, ReadonlyArray<{ key: string }>, CheckSpec[]]> = [
  ['kick2', KICK2_DESCRIPTORS, kick2Checks],
  ['snare2', SNARE2_DESCRIPTORS, snare2Checks],
  ['hat2', HAT2_DESCRIPTORS, hat2Checks],
  ['clap2', CLAP2_DESCRIPTORS, clap2Checks],
  ['synth2', SYNTH2_DESCRIPTORS, [...synth2Checks, ...synth2PerfChecks, ...synth2MatrixChecks(false)]],
];

describe('audit completeness: every descriptor key is checked or a declared blind spot', () => {
  it.each(CASES.map(([n, d, c]) => [n, d, c] as const))('%s', (_name, descriptors, checks) => {
    const covered = coveredParams(checks);
    const missing = descriptors
      .map((d) => d.key)
      .filter((k) => !covered.has(k) && !(k in BLIND_SPOTS));
    expect(missing, `unclassified params: ${missing.join(', ')} — add a check or a blind-spot entry`).toEqual([]);
  });
  it('blind spots only name real synth2 keys (no stale entries)', () => {
    const keys = new Set(SYNTH2_DESCRIPTORS.map((d) => d.key));
    for (const k of Object.keys(BLIND_SPOTS)) expect(keys.has(k), `stale blind spot '${k}'`).toBe(true);
  });
  // The other stale direction: a declared blind spot that LATER GAINS a real
  // check (e.g. a sync/div slot stops being main-thread-only and a check gets
  // added for it) must be caught too — the declaration is now a lie and
  // should be deleted, not left to silently over-claim "no check exists".
  it('blind spots have no check yet (one that gained coverage is stale)', () => {
    const synth2AllChecks = [...synth2Checks, ...synth2PerfChecks, ...synth2MatrixChecks(false)];
    const covered = coveredParams(synth2AllChecks);
    for (const k of Object.keys(BLIND_SPOTS)) {
      expect(covered.has(k), `'${k}' is declared a blind spot but is already covered by a check — remove the entry`).toBe(false);
    }
  });
});
