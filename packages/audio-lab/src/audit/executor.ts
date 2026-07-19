// Renders a CheckSpec's legs, analyzes them, and produces a CheckResult.
// KNOWN/STALE_KNOWN classification against the known-issues register happens
// here so the vitest entry and the report writer both see final statuses.
import type { AudioClip } from '../types';
import type { EngineRenderSpec } from '../render/engine';
import { noteToFreq } from '../render/engine';
import { analyzeForAudit, type AnalysisBundle } from './metrics';
import { pitchSettleTime } from '../analyze/pitch';
import type { CheckResult, CheckSpec, CheckStatus } from './types';

export type RenderFn = (spec: EngineRenderSpec) => AudioClip;

export interface RunCheckOpts {
  render: RenderFn;
  knownIssues: Record<string, string>;
  // Persist a failing render for inspection; returns the run-dir path.
  saveFailure?: (id: string, spec: EngineRenderSpec, clip: AudioClip) => Promise<string>;
}

interface Leg { label: string; spec: EngineRenderSpec; clip: AudioClip; bundle: AnalysisBundle }

const withParam = (spec: EngineRenderSpec, param: string, value: number): EngineRenderSpec =>
  ({ ...spec, params: { ...spec.params, [param]: value } });

export async function runCheck(check: CheckSpec, opts: RunCheckOpts): Promise<CheckResult> {
  const failures: string[] = [];
  const values: Record<string, number | null> = {};
  const problems: string[] = [];
  const legs: Leg[] = [];

  const renderLeg = (label: string, spec: EngineRenderSpec): Leg => {
    const clip = opts.render(spec);
    const bundle = analyzeForAudit(clip);
    const leg = { label, spec, clip, bundle };
    legs.push(leg);
    return leg;
  };

  const a = check.assertion;
  try {
    // --- render legs + evaluate the assertion ---
    if (a.kind === 'directional') {
      const from = renderLeg('from', withParam(check.baseline, a.param, a.from));
      const to = renderLeg('to', withParam(check.baseline, a.param, a.to));
      const mFrom = from.bundle.metrics[a.metric];
      const mTo = to.bundle.metrics[a.metric];
      values[`${a.metric}.from`] = mFrom;
      values[`${a.metric}.to`] = mTo;
      evalDelta(problems, a.metric, mFrom, mTo, a.direction, a.minDelta);
    } else if (a.kind === 'absolute') {
      const leg = renderLeg('render', check.baseline);
      const m = leg.bundle.metrics[a.metric];
      values[a.metric] = m;
      if (m == null) problems.push(`${a.metric} is null`);
      else {
        if (a.min !== undefined && m < a.min) problems.push(`${a.metric}=${fmt(m)} < min ${a.min}`);
        if (a.max !== undefined && m > a.max) problems.push(`${a.metric}=${fmt(m)} > max ${a.max}`);
      }
    } else if (a.kind === 'enum') {
      const seen: (number | null)[] = [];
      for (const v of a.values) {
        const leg = renderLeg(`v${v}`, withParam(check.baseline, a.param, v));
        const peak = leg.bundle.metrics.peakDb;
        values[`peakDb.v${v}`] = peak;
        if (peak == null || peak < a.minPeakDb) problems.push(`value ${v}: peakDb=${fmt(peak)} < ${a.minPeakDb}`);
        if (a.distinct) {
          const m = leg.bundle.metrics[a.distinct.metric];
          values[`${a.distinct.metric}.v${v}`] = m;
          seen.push(m);
        }
      }
      if (a.distinct) {
        const nums = seen.filter((x): x is number => x != null);
        const spread = nums.length ? Math.max(...nums) - Math.min(...nums) : 0;
        values[`${a.distinct.metric}.spread`] = spread;
        if (nums.length < seen.length) problems.push(`${a.distinct.metric} null for some values`);
        else if (spread < a.distinct.minSpread) problems.push(`${a.distinct.metric} spread ${fmt(spread)} < ${a.distinct.minSpread}`);
      }
    } else if (a.kind === 'route') {
      const route = { source: a.source, dest: a.dest, amount: a.amount };
      if (a.compare === 'off-vs-on') {
        const off = renderLeg('off', { ...check.baseline, matrix: check.baseline.matrix ?? [] });
        const on = renderLeg('on', { ...check.baseline, matrix: [...(check.baseline.matrix ?? []), route] });
        const mOff = off.bundle.metrics[a.metric];
        const mOn = on.bundle.metrics[a.metric];
        values[`${a.metric}.off`] = mOff;
        values[`${a.metric}.on`] = mOn;
        evalDelta(problems, a.metric, mOff, mOn, a.direction, a.minDelta);
      } else {
        const routed = { ...check.baseline, matrix: [...(check.baseline.matrix ?? []), route] };
        const soft = renderLeg('v0.3', { ...routed, notes: routed.notes.map((n) => ({ ...n, velocity: 0.3 })) });
        const hard = renderLeg('v1.0', { ...routed, notes: routed.notes.map((n) => ({ ...n, velocity: 1 })) });
        const mSoft = soft.bundle.metrics[a.metric];
        const mHard = hard.bundle.metrics[a.metric];
        values[`${a.metric}.v0.3`] = mSoft;
        values[`${a.metric}.v1.0`] = mHard;
        evalDelta(problems, a.metric, mSoft, mHard, a.direction, a.minDelta);
      }
    } else if (a.kind === 'pitchSettle') {
      const leg = renderLeg('render', check.baseline);
      const notes = check.baseline.notes;
      if (notes.length !== 2) throw new Error(`pitchSettle needs exactly 2 notes, got ${notes.length}`);
      const target = noteFreq(notes[1]);
      const settleAbs = pitchSettleTime(leg.bundle.pitch.frames, notes[1].time, target);
      // pitchSettleTime returns an ABSOLUTE clip time (frame.time), not time
      // elapsed since note 2's onset — subtract notes[1].time so this is
      // comparable to knobSeconds (types.ts: "from note 2 onset ~ knobSeconds").
      const settle = settleAbs == null ? null : settleAbs - notes[1].time;
      values['pitchSettleSeconds'] = settle;
      if (settle == null) problems.push('pitch never settled on note 2');
      else if (Math.abs(settle - a.knobSeconds) > a.toleranceSeconds) {
        problems.push(`settle ${fmt(settle)}s vs knob ${a.knobSeconds}s (tol ${a.toleranceSeconds}s)`);
      }
    } else if (a.kind === 'health') {
      renderLeg('render', check.baseline);
    } else {
      const exhaustive: never = a;
      throw new Error(`unhandled assertion kind ${(exhaustive as { kind: string }).kind}`);
    }

    // --- health policy: every rendered leg ---
    const allowed = new Set(check.allowedHealth ?? []);
    allowed.delete('NON_FINITE'); // never allowed
    for (const leg of legs) {
      const bad = leg.bundle.healthFlags.filter((f) => !allowed.has(f));
      if (bad.length) problems.push(`${leg.label}: disallowed health flags [${bad.join(', ')}]`);
    }
  } catch (err) {
    problems.push(`executor error: ${(err as Error).message}`);
  }

  // --- status classification ---
  let status: CheckStatus;
  const known = Object.prototype.hasOwnProperty.call(opts.knownIssues, check.id);
  if (problems.length === 0) status = known ? 'STALE_KNOWN' : 'PASS';
  else if (known) status = 'KNOWN';
  else status = 'FAIL';

  if (status === 'FAIL' && opts.saveFailure) {
    // Save only the last-rendered leg: the interesting one for single-leg
    // checks; for two-leg checks one render keeps the disk cost sane.
    const last = legs[legs.length - 1];
    if (last) failures.push(await opts.saveFailure(check.id, last.spec, last.clip));
  }

  const detail =
    status === 'PASS' ? 'ok'
    : status === 'STALE_KNOWN' ? `passes but listed in known-issues (${opts.knownIssues[check.id]}) — remove the entry`
    : problems.join('; ') + (known ? ` [known: ${opts.knownIssues[check.id]}]` : '');
  return { id: check.id, engine: check.engine, title: check.title, status, detail, values, failureDirs: failures };
}

function evalDelta(problems: string[], metric: string, from: number | null, to: number | null,
    direction: 'up' | 'down' | 'change', minDelta: number): void {
  if (from == null || to == null) { problems.push(`${metric} null (from=${fmt(from)}, to=${fmt(to)})`); return; }
  const delta = to - from;
  const ok = direction === 'up' ? delta >= minDelta
    : direction === 'down' ? delta <= -minDelta
    : Math.abs(delta) >= minDelta;
  if (!ok) problems.push(`${metric} delta ${fmt(delta)} failed ${direction} ≥ ${minDelta}`);
}

function noteFreq(n: { note?: string; freq?: number }): number {
  if (n.freq != null) return n.freq;
  return noteToFreq(n.note!);
}
const fmt = (x: number | null | undefined) => (x == null ? 'null' : x.toFixed(3));
