// Summary-level A/B deltas between two runs. Per-hop diffing is deliberately
// out of scope: the agent reads both reports' arrays directly when it needs
// fine-grained comparison. Renders are not bit-identical (free-running PRNGs),
// so treat sub-dB / sub-Hz deltas as noise.
import type { RunReport } from '../report/report';

export interface MetricDelta { a: number | null; b: number | null; delta: number | null }

export interface CompareResult {
  metrics: Record<string, MetricDelta>;
  notes: string[];
}

export function compareReports(a: RunReport, b: RunReport): CompareResult {
  const pick = (r: RunReport): Record<string, number | null> => ({
    peakDb: r.summary.peakDb,
    rmsDb: r.summary.rmsDb,
    medianF0: r.summary.medianF0,
    minF0: r.summary.f0Range ? r.summary.f0Range[0] : null,
    maxF0: r.summary.f0Range ? r.summary.f0Range[1] : null,
    meanCentroidHz: r.summary.meanCentroidHz,
    attackSeconds: r.summary.attackSeconds,
    decaySeconds: r.summary.decaySeconds,
    onsetCount: r.summary.onsets.length,
  });

  const va = pick(a);
  const vb = pick(b);
  const metrics: Record<string, MetricDelta> = {};
  for (const key of Object.keys(va)) {
    const x = va[key];
    const y = vb[key];
    metrics[key] = { a: x, b: y, delta: x !== null && y !== null ? y - x : null };
  }

  const notes: string[] = [];
  const fa = new Set(a.summary.healthFlags);
  const fb = new Set(b.summary.healthFlags);
  for (const f of fb) if (!fa.has(f)) notes.push(`health flag appeared in B: ${f}`);
  for (const f of fa) if (!fb.has(f)) notes.push(`health flag cleared in B: ${f}`);

  return { metrics, notes };
}
