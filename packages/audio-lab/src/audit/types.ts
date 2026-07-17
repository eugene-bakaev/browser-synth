// Audit check definitions. Checks are DATA; src/audit/executor.ts is the only
// code that renders and asserts. Sub-project C (Tier 2) reuses these types
// with a different render backend.
import type { EngineId, EngineRenderSpec } from '../render/engine';

export type MetricId =
  | 'peakDb' | 'rmsDb' | 'attackSeconds' | 'decaySeconds' | 'onsetCount'
  | 'medianF0' | 'f0WidthHz' | 'meanCentroidHz' | 'domPeakHz'
  | 'bandLo' | 'bandMid' | 'bandHi'
  | 'modDepthRms' | 'modDepthCentroid' | 'modDepthF0' | 'modRateCentroidHz';

export type Direction = 'up' | 'down' | 'change';

export type Assertion =
  // Render baseline with {param: from}, then {param: to}; metric must move.
  | { kind: 'directional'; param: string; from: number; to: number;
      metric: MetricId; direction: Direction; minDelta: number }
  // Single render of the baseline; metric inside [min, max].
  | { kind: 'absolute'; metric: MetricId; min?: number; max?: number }
  // One render per value; each must be healthy and audible; optionally the
  // metric must spread across values by at least minSpread.
  | { kind: 'enum'; param: string; values: number[]; minPeakDb: number;
      distinct?: { metric: MetricId; minSpread: number } }
  // Baseline must contain exactly two overlapping/adjacent mono notes;
  // pitchSettleTime from note 2 onset to note 2 freq ~ knobSeconds.
  | { kind: 'pitchSettle'; knobSeconds: number; toleranceSeconds: number }
  // Render baseline WITHOUT the route, then WITH it; metric must move.
  // 'velocity-pair' instead renders WITH the route at velocity 0.3 vs 1.0.
  | { kind: 'route'; source: string; dest: string; amount: number;
      compare: 'off-vs-on' | 'velocity-pair';
      metric: MetricId; direction: Direction; minDelta: number }
  // Health-only: render must obey the health policy, nothing else asserted.
  | { kind: 'health' };

export interface CheckSpec {
  id: string;                      // 'synth2.filter.cutoff.dir'
  engine: EngineId;
  title: string;                   // one line for the report
  baseline: EngineRenderSpec;
  assertion: Assertion;
  allowedHealth?: string[];        // default []; NON_FINITE never allowed
}

export type CheckStatus = 'PASS' | 'FAIL' | 'KNOWN' | 'STALE_KNOWN';

export interface CheckResult {
  id: string;
  engine: EngineId;
  title: string;
  status: CheckStatus;
  detail: string;                          // human-readable outcome
  values: Record<string, number | null>;   // every measured metric, both legs
  failureDirs: string[];                   // run dirs written for FAILs
}
