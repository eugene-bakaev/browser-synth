// THE audit suite entry. Runs ONLY under vitest.audit.config.ts
// (npm run lab:audit); the normal gate excludes this file.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderEngine, type EngineRenderSpec } from '../render/engine';
import type { AudioClip } from '../types';
import { writeRunDir } from '../report/report';
import { runCheck } from './executor';
import { writeAuditReport } from './report';
import { KNOWN_ISSUES } from './known-issues';
import type { CheckResult, CheckSpec } from './types';
import { drumBase } from './checks/baselines';
// task-6..10 imports go here:
// import { kick2Checks } from './checks/kick2.checks';
// …

const FAST = process.env.AUDIT_FAST === '1';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const AUDIT_DIR = join(import.meta.dirname, '..', '..', '.audio-lab', 'audit', STAMP);

// TEMPORARY smoke checks proving the pipeline end-to-end against real
// kernels. Task 6's kick2 table subsumes these; remove then.
// kick2's default patch legitimately clips (raw kernel, no mixer gain
// staging — same known truth as SYNTH2_LEVELS above), so CLIPPING is
// allowed alongside MOSTLY_SILENT rather than a DSP change to fix it.
const checks: CheckSpec[] = [
  { id: 'smoke.kick2.audible', engine: 'kick2', title: 'default kick is audible',
    baseline: drumBase('kick2'), assertion: { kind: 'absolute', metric: 'peakDb', min: -30 },
    allowedHealth: ['MOSTLY_SILENT', 'CLIPPING'] },
  { id: 'smoke.kick2.decay', engine: 'kick2', title: 'decay knob lengthens decay',
    baseline: drumBase('kick2'), allowedHealth: ['MOSTLY_SILENT', 'CLIPPING'],
    assertion: { kind: 'directional', param: 'decay', from: 0.1, to: 1.0, metric: 'decaySeconds', direction: 'up', minDelta: 0.15 } },
];

const saveFailure = async (id: string, spec: EngineRenderSpec, clip: AudioClip): Promise<string> => {
  const dir = join(AUDIT_DIR, 'failures', id);
  await mkdir(dir, { recursive: true });
  await writeRunDir({ dir, spec, clip });
  return dir;
};

const results: CheckResult[] = [];
const byEngine = new Map<string, CheckSpec[]>();
for (const c of checks) {
  if (!byEngine.has(c.engine)) byEngine.set(c.engine, []);
  byEngine.get(c.engine)!.push(c);
}

for (const [engine, engineChecks] of byEngine) {
  describe(engine, () => {
    it.each(engineChecks.map((c) => [c.id, c] as const))('%s', async (_id, check) => {
      const r = await runCheck(check, { render: renderEngine, knownIssues: KNOWN_ISSUES, saveFailure });
      results.push(r);
      // KNOWN keeps the suite green; STALE_KNOWN nags in the report only.
      expect(r.status === 'FAIL' ? `${r.status}: ${r.detail}` : 'ok').toBe('ok');
    }, 120_000);
  });
}

afterAll(async () => {
  if (!results.length) return;
  const { md } = await writeAuditReport(results, AUDIT_DIR);
  console.log(`\naudit report: ${md} (fast=${FAST})`);
});
