// Public library surface — other packages (future regression tests) import
// from here, never from deep paths.
export type { AudioClip } from './types';
export { DEFAULT_SAMPLE_RATE } from './types';
export { renderEngine, noteToFreq, ENGINE_IDS } from './render/engine';
export type { EngineRenderSpec, NoteEvent, MatrixRoute, EngineId } from './render/engine';
export { analyzeEnvelope, db, SILENCE_FLOOR_DB } from './analyze/envelope';
export type { EnvelopeAnalysis, EnvelopePoint } from './analyze/envelope';
export { analyzePitch, pitchSettleTime } from './analyze/pitch';
export type { PitchAnalysis, PitchFrame } from './analyze/pitch';
export { analyzeSpectrum } from './analyze/spectrum';
export type { SpectrumAnalysis, SpectralPeak, SpectrogramData } from './analyze/spectrum';
export { analyzeHealth } from './analyze/health';
export type { HealthReport } from './analyze/health';
export { compareReports } from './analyze/compare';
export type { CompareResult, MetricDelta } from './analyze/compare';
export { buildReport, writeRunDir, defaultRunDir } from './report/report';
export type {
  RunReport,
  RunSummary,
  ReportEnvelope,
  ReportEnvelopePoint,
  PitchSettleEntry,
  BuildReportOpts,
} from './report/report';
export { encodeWav, decodeWav } from './report/wav';
