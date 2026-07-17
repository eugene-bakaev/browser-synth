// Writes audit-report.md (human) + audit-report.json (machine) for one run.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult, CheckStatus } from './types';

const ORDER: CheckStatus[] = ['FAIL', 'STALE_KNOWN', 'KNOWN', 'PASS'];
const ICON: Record<CheckStatus, string> = { PASS: '✅', FAIL: '❌', KNOWN: '🟡', STALE_KNOWN: '⚠️ STALE' };

export async function writeAuditReport(results: CheckResult[], dir: string): Promise<{ md: string; json: string }> {
  await mkdir(dir, { recursive: true });
  const counts: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, KNOWN: 0, STALE_KNOWN: 0 };
  for (const r of results) counts[r.status]++;

  const engines = [...new Set(results.map((r) => r.engine))];
  let md = `# Audit report — ${new Date().toISOString()}\n\n`;
  md += `**${results.length} checks: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.KNOWN} KNOWN, ${counts.STALE_KNOWN} STALE_KNOWN**\n\n`;
  for (const engine of engines) {
    md += `## ${engine}\n\n`;
    const rows = results.filter((r) => r.engine === engine)
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
    for (const r of rows) {
      md += `- ${ICON[r.status]} \`${r.id}\` — ${r.title}`;
      if (r.status !== 'PASS') md += `\n  - ${r.detail}`;
      for (const d of r.failureDirs) md += `\n  - render: ${d}`;
      md += '\n';
    }
    md += '\n';
  }
  const mdPath = join(dir, 'audit-report.md');
  const jsonPath = join(dir, 'audit-report.json');
  await writeFile(mdPath, md);
  await writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2));
  return { md: mdPath, json: jsonPath };
}
