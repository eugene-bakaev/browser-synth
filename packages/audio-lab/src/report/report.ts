// Assembles a run directory: report.json (the agent's primary input — summary
// first, full per-hop detail after), plots, WAV, and the input spec for
// replayability. All -Infinity dB values serialize as null (JSON has no
// Infinity; JSON.stringify would emit the string "null" anyway — this makes
// it explicit and typed).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioClip } from '../types';
import { analyzeEnvelope } from '../analyze/envelope';
import { analyzePitch, pitchSettleTime, type PitchFrame } from '../analyze/pitch';
import { analyzeSpectrum, type SpectralPeak } from '../analyze/spectrum';
import { analyzeHealth, type HealthReport } from '../analyze/health';
import { encodeWav } from './wav';
import { waveformPng, spectrogramPng, envelopeSvg, pitchSvg } from './plots';

export interface ReportEnvelopePoint { time: number; rmsDb: number | null; peakDb: number | null }
export interface ReportEnvelope {
  hopSeconds: number;
  points: ReportEnvelopePoint[];
  peakDb: number | null;
  rmsDb: number | null;
  onsets: number[];
  attackSeconds: number | null;
  decaySeconds: number | null;
}
export interface PitchSettleEntry { time: number; targetHz: number; settleSeconds: number | null }

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
  pitchSettle: PitchSettleEntry[] | null;
}

export interface RunReport {
  summary: RunSummary;
  envelope: ReportEnvelope;
  pitch: {
    frames: PitchFrame[];
    medianF0: number | null;
    minF0: number | null;
    maxF0: number | null;
  };
  spectrum: {
    binHz: number;
    hopSeconds: number;
    averageMagnitudeDb: number[];
    peaks: SpectralPeak[];
    centroidHz: (number | null)[];
    meanCentroidHz: number | null;
  };
  health: HealthReport;
}

const finite = (x: number): number | null => (Number.isFinite(x) ? x : null);

export interface BuildReportOpts { noteTargets?: Array<{ time: number; freq: number }> }

export function buildReport(clip: AudioClip, opts: BuildReportOpts = {}): RunReport {
  const envelope = analyzeEnvelope(clip);
  const pitch = analyzePitch(clip);
  const spectrum = analyzeSpectrum(clip);
  const health = analyzeHealth(clip);

  // JSON-safe envelope: -Infinity dB → null, honestly typed as number | null
  // (rather than cast back to number) so downstream consumers can't forget
  // to guard against silence.
  const safeEnvelope: ReportEnvelope = {
    hopSeconds: envelope.hopSeconds,
    onsets: envelope.onsets,
    attackSeconds: envelope.attackSeconds,
    decaySeconds: envelope.decaySeconds,
    peakDb: finite(envelope.peakDb),
    rmsDb: finite(envelope.rmsDb),
    points: envelope.points.map((p) => ({ time: p.time, rmsDb: finite(p.rmsDb), peakDb: finite(p.peakDb) })),
  };

  const pitchSettle: PitchSettleEntry[] | null = opts.noteTargets
    ? opts.noteTargets.map((t) => {
        // pitchSettleTime returns an ABSOLUTE clip time (raw frame.time).
        // Report elapsed-since-note-onset — the field's natural reading and
        // the audit executor's semantics (fix 87dcae3); keeping report.json
        // absolute caused the same misread the executor bug did.
        const abs = pitchSettleTime(pitch.frames, t.time, t.freq);
        return { time: t.time, targetHz: t.freq, settleSeconds: abs === null ? null : abs - t.time };
      })
    : null;

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
      pitchSettle,
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
      hopSeconds: spectrum.hopSeconds,
      averageMagnitudeDb: spectrum.averageMagnitudeDb,
      peaks: spectrum.peaks,
      centroidHz: spectrum.centroidHz,
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
  noteTargets?: BuildReportOpts['noteTargets'];
}): Promise<RunReport> {
  const { dir, spec, clip, noteTargets } = opts;
  const report = buildReport(clip, { noteTargets });
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
