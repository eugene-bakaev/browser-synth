// Shared audit baselines. Synth2 renders at osc levels 0.2/0.2 — raw kernels
// have no mixer gain staging and CLIP at the 0.8/0.8 defaults (known truth;
// only the default-patch fingerprint checks render defaults, with CLIPPING
// allowed). Drums render one hit and enough tail to measure decay.
import type { EngineId, EngineRenderSpec } from '../../render/engine';

export const SYNTH2_LEVELS = { 'osc1.level': 0.2, 'osc2.level': 0.2, 'osc3.level': 0 };

export const synth2Base = (over: Partial<EngineRenderSpec> = {}): EngineRenderSpec => ({
  engine: 'synth2',
  params: { ...SYNTH2_LEVELS, ...(over.params ?? {}) },
  notes: over.notes ?? [{ time: 0, note: 'A3', duration: 0.5 }],
  seconds: over.seconds ?? 1.2,
  matrix: over.matrix,
});

// A held 2s note for modulation checks (LFO cycles, env loops need room).
export const synth2Held = (params: Record<string, number> = {}, matrix?: EngineRenderSpec['matrix']): EngineRenderSpec =>
  synth2Base({ params, matrix, notes: [{ time: 0, note: 'A3', duration: 2 }], seconds: 2.4 });

export const drumBase = (engine: EngineId, params: Record<string, number> = {}, seconds = 1.2): EngineRenderSpec => ({
  engine, params, notes: [{ time: 0, note: 'C3', duration: 0.3 }], seconds,
});
