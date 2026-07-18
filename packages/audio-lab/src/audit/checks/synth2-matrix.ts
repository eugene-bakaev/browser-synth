// The full synth2 mod-matrix audit: MOD_SOURCES x MOD_DESTS, each real cell
// asserted through its destination family's metric template. 'none' cells
// and EXPECTED_INERT cells render health-only.
//
// CALIBRATED (Task 10, two consecutive `npm run lab:audit` runs; full numbers
// in the commit body / task-10-report.md).
import { MOD_DESTS, MOD_SOURCES } from '@fiddle/shared';
import type { CheckSpec, MetricId } from '../types';
import { synth2Base, synth2Held } from './baselines';

export type DestFamily = 'pitch' | 'timbre' | 'level' | 'filter' | 'fm' | 'envtime' | 'lforate' | 'glide';

export const DEST_FAMILY: Record<string, DestFamily> = {
  'osc1.coarse': 'pitch', 'osc1.fine': 'pitch', 'osc2.coarse': 'pitch', 'osc2.fine': 'pitch',
  'osc3.coarse': 'pitch', 'osc3.fine': 'pitch',
  'osc1.morph': 'timbre', 'osc1.pulseWidth': 'timbre', 'osc2.morph': 'timbre', 'osc2.pulseWidth': 'timbre',
  'osc3.morph': 'timbre', 'osc3.pulseWidth': 'timbre', 'noise.color': 'timbre',
  'lfo1.shape': 'timbre', 'lfo2.shape': 'timbre',
  'osc1.level': 'level', 'osc2.level': 'level', 'osc3.level': 'level', 'noise.level': 'level',
  'filter.cutoff': 'filter', 'filter.resonance': 'filter', 'filter.keyTrack': 'filter',
  'filter.drive': 'filter', 'filter.morph': 'filter',
  'fm.osc2': 'fm', 'fm.osc3': 'fm',
  'env1.a': 'envtime', 'env1.d': 'envtime', 'env1.s': 'envtime', 'env1.r': 'envtime',
  'env2.a': 'envtime', 'env2.d': 'envtime', 'env2.s': 'envtime', 'env2.r': 'envtime',
  'env3.a': 'envtime', 'env3.d': 'envtime', 'env3.s': 'envtime', 'env3.r': 'envtime',
  'lfo1.rate': 'lforate', 'lfo2.rate': 'lforate',
  'glide.time': 'glide',
};

// Cells whose family metric is not expected to move measurably in a Tier-1
// render; they assert health only. Every entry needs a reason. Populated
// further during calibration — each addition must carry a one-line comment.
export const EXPECTED_INERT: ReadonlyArray<readonly [string, string]> = [
  // lfoN.shape modulated by lfoN itself is self-referential and sub-noise:
  ['lfo1', 'lfo1.shape'], ['lfo2', 'lfo2.shape'],
];

// Per-family: metric for a periodic/stochastic source (modDepth-style, on a
// held note) and scalar metric for one-shot (env) / static (velocity) sources.
const FAMILY_METRIC: Record<DestFamily, { depth: MetricId; scalar: MetricId; minDepth: number; minScalar: number }> = {
  pitch:   { depth: 'modDepthF0',       scalar: 'f0WidthHz',        minDepth: 5,    minScalar: 8 },
  timbre:  { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',   minDepth: 60,   minScalar: 80 },
  level:   { depth: 'modDepthRms',      scalar: 'rmsDb',            minDepth: 1.5,  minScalar: 2 },
  filter:  { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',   minDepth: 80,   minScalar: 100 },
  fm:      { depth: 'modDepthCentroid', scalar: 'meanCentroidHz',   minDepth: 60,   minScalar: 80 },
  envtime: { depth: 'modDepthRms',      scalar: 'decaySeconds',     minDepth: 1,    minScalar: 0.05 },
  lforate: { depth: 'modDepthCentroid', scalar: 'modRateCentroidHz', minDepth: 40,  minScalar: 1.5 },
  glide:   { depth: 'modDepthF0',       scalar: 'medianF0',         minDepth: 4,    minScalar: 3 },
};

// Baselines engineered so the dest is LIVE: env3 dests need env3 routed;
// lfoN.rate/shape dests need that LFO routed; glide needs a mono note pair;
// env2 dests rely on the default filter.envAmount 2.4 with a dark cutoff.
function baselineFor(dest: string): CheckSpec['baseline'] {
  const params: Record<string, number> = { 'filter.cutoff': 1200 };
  const matrix: { source: string; dest: string; amount: number }[] = [];
  if (dest.startsWith('env3.')) matrix.push({ source: 'env3', dest: 'osc1.fine', amount: 0.6 });
  if (dest.startsWith('env2.')) params['filter.cutoff'] = 400;
  if (dest === 'lfo1.rate' || dest === 'lfo1.shape') { params['lfo1.rate'] = 4; matrix.push({ source: 'lfo1', dest: 'filter.cutoff', amount: 0.7 }); }
  if (dest === 'lfo2.rate' || dest === 'lfo2.shape') { params['lfo2.rate'] = 4; matrix.push({ source: 'lfo2', dest: 'filter.cutoff', amount: 0.7 }); }
  if (dest === 'glide.time') {
    return synth2Base({ params: { 'glide.time': 0.05 },
      notes: [{ time: 0, note: 'A2', duration: 0.9, mono: true }, { time: 1.0, note: 'A3', duration: 1.0, mono: true }],
      seconds: 2.4 });
  }
  if (dest.startsWith('env1.')) { params['env1.d'] = 0.3; params['env1.s'] = 0.4; }
  return synth2Held(params, matrix);
}

export function synth2MatrixChecks(fast: boolean): CheckSpec[] {
  const checks: CheckSpec[] = [];
  const inert = new Set(EXPECTED_INERT.map(([s, d]) => `${s}->${d}`));
  const seenFastKey = new Set<string>();

  for (const source of MOD_SOURCES) {
    for (const dest of MOD_DESTS) {
      const id = `synth2.matrix.${source}->${dest}`;
      const family = dest === 'none' ? null : DEST_FAMILY[dest];
      const isInert = source === 'none' || dest === 'none' || inert.has(`${source}->${dest}`);

      if (fast && family) {
        const key = `${source}:${family}:${isInert}`;
        if (seenFastKey.has(key)) continue;
        seenFastKey.add(key);
      }

      const baseline = dest === 'none' ? synth2Held() : baselineFor(dest);
      if (isInert) {
        // dest === 'none' can't be encoded as a matrix route at all (the
        // Tier-1 renderer's MatrixRoute requires a real PARAM_INDEX dest —
        // the kernel's wire-level "no destination" is destEnc=0, a path this
        // API doesn't expose) — a route with no destination is definitionally
        // a no-op, identical to omitting the route, so just render the plain
        // baseline. source === 'none' with a real dest IS safely encodable:
        // Voice.ts never writes sources[0] ('none' is index 0), so it's a
        // permanent, harmless 0 contribution — include the route for those.
        const extraRoute = dest === 'none' ? [] : [{ source, dest, amount: 0.8 }];
        checks.push({ id, engine: 'synth2', title: `route ${source} -> ${dest} renders healthily`,
          baseline: { ...baseline, matrix: [...(baseline.matrix ?? []), ...extraRoute] },
          assertion: { kind: 'health' } });
        continue;
      }
      const fam = FAMILY_METRIC[family!];
      const oneShot = source.startsWith('env');
      const isVelocity = source === 'velocity';
      checks.push({
        id, engine: 'synth2', title: `route ${source} -> ${dest} moves ${family}`,
        baseline,
        assertion: isVelocity
          ? { kind: 'route', source, dest, amount: 0.8, compare: 'velocity-pair', metric: fam.scalar, direction: 'change', minDelta: fam.minScalar }
          : oneShot
            ? { kind: 'route', source, dest, amount: 0.8, compare: 'off-vs-on', metric: fam.scalar, direction: 'change', minDelta: fam.minScalar }
            : { kind: 'route', source, dest, amount: 0.8, compare: 'off-vs-on', metric: fam.depth, direction: 'up', minDelta: fam.minDepth },
      });
    }
  }
  return checks;
}
