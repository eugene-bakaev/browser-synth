// Assembles a run directory: report.json (the agent's primary input — summary
// first, full per-hop detail after), plots, WAV, and the input spec for
// replayability. All -Infinity dB values serialize as null (JSON has no
// Infinity; JSON.stringify would emit the string "null" anyway — this makes
// it explicit and typed).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioClip } from '../types';
import { analyzeEnvelope, type EnvelopeAnalysis } from '../analyze/envelope';
import { analyzePitch, type PitchFrame } from '../analyze/pitch';
import { analyzeSpectrum, type SpectralPeak } from '../analyze/spectrum';
import { analyzeHealth, type HealthReport } from '../analyze/health';
import { encodeWav } from './wav';
import { waveformPng, spectrogramPng, envelopeSvg, pitchSvg } from './plots';

export interface RunSummary {
  seconds: number;
  sampleRate: number;
  peakDb: number | null;
  rmsDb: number | null;
  onsets: number[];
  attackSeconds: number | null;
  decaySeconds: number | null;
  medianF0: number | null;
  f0Range: [number, number] | null;
  meanCentroidHz: number | null;
  spectralPeaks: SpectralPeak[];
  healthFlags: string[];
}

export interface RunReport {
  summary: RunSummary;
  envelope: EnvelopeAnalysis;
  pitch: {
    frames: PitchFrame[];
    medianF0: number | null;
    minF0: number | null;
    maxF0: number | null;
  };
  spectrum: {
    binHz: number;
    averageMagnitudeDb: number[];
    peaks: SpectralPeak[];
    meanCentroidHz: number | null;
  };
  health: HealthReport;
}

const finite = (x: number): number | null => (Number.isFinite(x) ? x : null);

export function buildReport(clip: AudioClip): RunReport {
  const envelope = analyzeEnvelope(clip);
  const pitch = analyzePitch(clip);
  const spectrum = analyzeSpectrum(clip);
  const health = analyzeHealth(clip);

  // JSON-safe envelope: -Infinity dB → null (typed as number in EnvelopeAnalysis,
  // patched at the serialization boundary here).
  const safeEnvelope: EnvelopeAnalysis = {
    ...envelope,
    peakDb: (finite(envelope.peakDb) ?? null) as number,
    rmsDb: (finite(envelope.rmsDb) ?? null) as number,
    points: envelope.points.map((p) => ({
      time: p.time,
      rmsDb: (finite(p.rmsDb) ?? null) as unknown as number,
      peakDb: (finite(p.peakDb) ?? null) as unknown as number,
    })),
  };

  return {
    summary: {
      seconds: clip.samples.length / clip.sampleRate,
      sampleRate: clip.sampleRate,
      peakDb: finite(envelope.peakDb),
      rmsDb: finite(envelope.rmsDb),
      onsets: envelope.onsets,
      attackSeconds: envelope.attackSeconds,
      decaySeconds: envelope.decaySeconds,
      medianF0: pitch.medianF0,
      f0Range: pitch.minF0 !== null && pitch.maxF0 !== null ? [pitch.minF0, pitch.maxF0] : null,
      meanCentroidHz: spectrum.meanCentroidHz,
      spectralPeaks: spectrum.peaks,
      healthFlags: health.flags,
    },
    envelope: safeEnvelope,
    pitch: {
      frames: pitch.frames,
      medianF0: pitch.medianF0,
      minF0: pitch.minF0,
      maxF0: pitch.maxF0,
    },
    spectrum: {
      binHz: spectrum.binHz,
      averageMagnitudeDb: spectrum.averageMagnitudeDb,
      peaks: spectrum.peaks,
      meanCentroidHz: spectrum.meanCentroidHz,
    },
    health,
  };
}

export function defaultRunDir(label: string): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return `.audio-lab/runs/${stamp}-${safe}`;
}

export async function writeRunDir(opts: {
  dir: string;
  spec: unknown;
  clip: AudioClip;
}): Promise<RunReport> {
  const { dir, spec, clip } = opts;
  const report = buildReport(clip);
  const spectrum = analyzeSpectrum(clip);
  const envelope = analyzeEnvelope(clip);
  const pitch = analyzePitch(clip);

  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2)),
    writeFile(join(dir, 'spec.json'), JSON.stringify(spec, null, 2)),
    writeFile(join(dir, 'render.wav'), encodeWav(clip)),
    writeFile(join(dir, 'waveform.png'), waveformPng(clip)),
    writeFile(join(dir, 'spectrogram.png'), spectrogramPng(spectrum.spectrogram, clip.sampleRate, spectrum.fftSize)),
    writeFile(join(dir, 'envelope.svg'), envelopeSvg(envelope)),
    writeFile(join(dir, 'pitch.svg'), pitchSvg(pitch)),
  ]);
  return report;
}
