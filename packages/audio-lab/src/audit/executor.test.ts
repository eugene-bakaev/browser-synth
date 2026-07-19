import { describe, expect, it } from 'vitest';
import type { EngineRenderSpec } from '../render/engine';
import { runCheck } from './executor';
import type { CheckSpec } from './types';

const SR = 44100;
// Louder when params.gain is higher; brighter (higher freq) when params.bright is higher.
function stubRender(spec: EngineRenderSpec) {
  const gain = spec.params?.gain ?? 0.3;
  const freq = 200 + 2000 * (spec.params?.bright ?? 0.2) + 500 * (spec.matrix?.length ?? 0);
  const vel = spec.notes[0]?.velocity ?? 1;
  const n = Math.round(spec.seconds * SR);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = gain * vel * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}
const brokenRender = (spec: EngineRenderSpec) => {
  const c = stubRender(spec);
  c.samples[100] = Number.NaN;
  return c;
};
// Two-segment clip: holds notes[0]'s freq, then glides linearly to notes[1]'s
// freq starting at notes[1].time over params['glide.time'] seconds (0 = instant).
import { noteToFreq } from '../render/engine';
function glideRender(spec: EngineRenderSpec) {
  const notes = spec.notes;
  const freq1 = notes[0].freq ?? noteToFreq(notes[0].note!);
  const freq2 = notes[1].freq ?? noteToFreq(notes[1].note!);
  const glideSeconds = spec.params?.['glide.time'] ?? 0;
  const t2 = notes[1].time;
  const n = Math.round(spec.seconds * SR);
  const samples = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = t < t2 ? freq1 : glideSeconds <= 0 || t >= t2 + glideSeconds
      ? freq2 : freq1 + (freq2 - freq1) * ((t - t2) / glideSeconds);
    phase += (2 * Math.PI * f) / SR;
    samples[i] = 0.5 * Math.sin(phase);
  }
  return { samples, sampleRate: SR };
}

const base = (params: Record<string, number> = {}): EngineRenderSpec => ({
  engine: 'synth2', params, notes: [{ time: 0, note: 'A3', duration: 0.5 }], seconds: 1,
});
const check = (over: Partial<CheckSpec>): CheckSpec => ({
  id: 't.check', engine: 'synth2', title: 't', baseline: base(), assertion: { kind: 'health' }, ...over,
});
const opts = { render: stubRender, knownIssues: {} as Record<string, string> };

describe('runCheck', () => {
  it('directional up PASSes when the metric rises', async () => {
    const r = await runCheck(check({ assertion: { kind: 'directional', param: 'bright', from: 0.1, to: 0.9, metric: 'meanCentroidHz', direction: 'up', minDelta: 200 } }), opts);
    expect(r.status).toBe('PASS');
    expect(r.values['meanCentroidHz.from']).not.toBeNull();
    expect(r.values['meanCentroidHz.to']).not.toBeNull();
  });
  it('directional FAILs when the metric does not move enough', async () => {
    const r = await runCheck(check({ assertion: { kind: 'directional', param: 'unused', from: 0, to: 1, metric: 'meanCentroidHz', direction: 'up', minDelta: 200 } }), opts);
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('meanCentroidHz');
  });
  it("direction 'change' accepts movement either way", async () => {
    const r = await runCheck(check({ assertion: { kind: 'directional', param: 'bright', from: 0.9, to: 0.1, metric: 'meanCentroidHz', direction: 'change', minDelta: 200 } }), opts);
    expect(r.status).toBe('PASS');
  });
  it('absolute enforces min/max', async () => {
    const ok = await runCheck(check({ assertion: { kind: 'absolute', metric: 'peakDb', min: -20, max: 0 } }), opts);
    expect(ok.status).toBe('PASS');
    const bad = await runCheck(check({ assertion: { kind: 'absolute', metric: 'peakDb', min: -1 } }), opts);
    expect(bad.status).toBe('FAIL');
  });
  it('enum renders every value and enforces audibility + distinctness', async () => {
    const r = await runCheck(check({ assertion: { kind: 'enum', param: 'bright', values: [0, 0.5, 1], minPeakDb: -30, distinct: { metric: 'meanCentroidHz', minSpread: 500 } } }), opts);
    expect(r.status).toBe('PASS');
    const dull = await runCheck(check({ assertion: { kind: 'enum', param: 'unused', values: [0, 1], minPeakDb: -30, distinct: { metric: 'meanCentroidHz', minSpread: 500 } } }), opts);
    expect(dull.status).toBe('FAIL');
  });
  it('route off-vs-on sees the matrix-driven change', async () => {
    const r = await runCheck(check({ assertion: { kind: 'route', source: 'lfo1', dest: 'filter.cutoff', amount: 0.8, compare: 'off-vs-on', metric: 'meanCentroidHz', direction: 'change', minDelta: 200 } }), opts);
    expect(r.status).toBe('PASS');
  });
  it('route velocity-pair compares velocity 0.3 vs 1.0 (both routed)', async () => {
    const r = await runCheck(check({ assertion: { kind: 'route', source: 'velocity', dest: 'osc1.level', amount: 1, compare: 'velocity-pair', metric: 'peakDb', direction: 'up', minDelta: 3 } }), opts);
    expect(r.status).toBe('PASS');
  });
  it('NON_FINITE always FAILs regardless of assertion or allowedHealth', async () => {
    const r = await runCheck(check({ allowedHealth: ['NON_FINITE'] }), { ...opts, render: brokenRender });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('NON_FINITE');
  });
  it('disallowed health flag FAILs; allowed one PASSes', async () => {
    const loud = check({ baseline: base({ gain: 1.4 }) }); // clips the stub sine
    const fail = await runCheck(loud, opts);
    expect(fail.status).toBe('FAIL');
    const ok = await runCheck({ ...loud, allowedHealth: ['CLIPPING'] }, opts);
    expect(ok.status).toBe('PASS');
  });
  it('a failing check in knownIssues reports KNOWN; a passing one reports STALE_KNOWN', async () => {
    const failing = check({ id: 'k1', assertion: { kind: 'absolute', metric: 'peakDb', min: 100 } });
    const known = { k1: 'expected', k2: 'stale' };
    expect((await runCheck(failing, { ...opts, knownIssues: known })).status).toBe('KNOWN');
    const passing = check({ id: 'k2' });
    expect((await runCheck(passing, { ...opts, knownIssues: known })).status).toBe('STALE_KNOWN');
  });
  it('pitchSettle measures elapsed time from note 2 onset, not absolute clip time', async () => {
    const spec: EngineRenderSpec = {
      engine: 'synth2', params: { 'glide.time': 0.1 },
      notes: [{ time: 0, note: 'A2', duration: 0.4 }, { time: 0.5, note: 'A3', duration: 0.5 }],
      seconds: 1.2,
    };
    const chk = check({ baseline: spec, assertion: { kind: 'pitchSettle', knobSeconds: 0.1, toleranceSeconds: 0.03 } });
    const r = await runCheck(chk, { ...opts, render: glideRender });
    expect(r.status).toBe('PASS');
    // If this regressed to comparing an absolute clip time against knobSeconds,
    // pitchSettleSeconds would read ~0.6 (0.5 note-2 onset + ~0.1 glide), not ~0.1.
    expect(r.values['pitchSettleSeconds']).not.toBeNull();
    expect(Math.abs((r.values['pitchSettleSeconds'] as number) - 0.1)).toBeLessThan(0.03);
  });
  it('pitchSettle FAILs when the elapsed settle time misses the knob', async () => {
    const spec: EngineRenderSpec = {
      engine: 'synth2', params: { 'glide.time': 0.5 },
      notes: [{ time: 0, note: 'A2', duration: 0.4 }, { time: 0.5, note: 'A3', duration: 0.8 }],
      seconds: 1.6,
    };
    const chk = check({ baseline: spec, assertion: { kind: 'pitchSettle', knobSeconds: 0.05, toleranceSeconds: 0.02 } });
    const r = await runCheck(chk, { ...opts, render: glideRender });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('settle');
  });
  it('writes a failure dir when saveFailure is provided and the check FAILs', async () => {
    const saved: string[] = [];
    const r = await runCheck(check({ assertion: { kind: 'absolute', metric: 'peakDb', min: 100 } }), {
      ...opts,
      saveFailure: async (id) => { saved.push(id); return `/fake/${id}`; },
    });
    expect(r.status).toBe('FAIL');
    expect(saved).toEqual(['t.check']);
    expect(r.failureDirs).toEqual(['/fake/t.check']);
  });
});
