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
import { kick2Checks } from './checks/kick2.checks';
import { snare2Checks } from './checks/snare2.checks';
import { hat2Checks } from './checks/hat2.checks';
import { clap2Checks } from './checks/clap2.checks';
import { synth2Checks } from './checks/synth2.checks';
import { synth2PerfChecks } from './checks/synth2-perf.checks';
// task-10 imports go here:
// …

const FAST = process.env.AUDIT_FAST === '1';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const AUDIT_DIR = join(import.meta.dirname, '..', '..', '.audio-lab', 'audit', STAMP);

const checks: CheckSpec[] = [
  ...kick2Checks, ...snare2Checks, ...hat2Checks, ...clap2Checks, ...synth2Checks, ...synth2PerfChecks,
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
