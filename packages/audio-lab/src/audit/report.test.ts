import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAuditReport } from './report';
import type { CheckResult } from './types';

const res = (over: Partial<CheckResult>): CheckResult => ({
  id: 'x', engine: 'kick2', title: 't', status: 'PASS', detail: 'ok', values: { peakDb: -6.2 }, failureDirs: [], ...over,
});

describe('writeAuditReport', () => {
  it('writes md + json grouped by engine with a status summary line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    const results = [
      res({ id: 'kick2.a' }),
      res({ id: 'synth2.b', engine: 'synth2', status: 'FAIL', detail: 'delta too small', failureDirs: ['/runs/f1'] }),
      res({ id: 'synth2.c', engine: 'synth2', status: 'KNOWN', detail: 'expected' }),
      res({ id: 'kick2.d', status: 'STALE_KNOWN', detail: 'remove entry' }),
    ];
    await writeAuditReport(results, dir);
    const md = await readFile(join(dir, 'audit-report.md'), 'utf8');
    const json = JSON.parse(await readFile(join(dir, 'audit-report.json'), 'utf8'));
    expect(md).toContain('## synth2');
    expect(md).toContain('## kick2');
    expect(md).toContain('1 FAIL');
    expect(md).toContain('/runs/f1');
    expect(md).toContain('STALE');
    expect(json.results).toHaveLength(4);
    expect(json.counts).toEqual({ PASS: 1, FAIL: 1, KNOWN: 1, STALE_KNOWN: 1 });
  });
});
