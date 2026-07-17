import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, writeRunDir, defaultRunDir } from './report';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number): AudioClip {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

describe('buildReport', () => {
  it('summary carries the cross-metric essentials', () => {
    const r = buildReport(sine(440, 0.5));
    expect(r.summary.seconds).toBeCloseTo(0.5, 3);
    expect(r.summary.sampleRate).toBe(SR);
    expect(r.summary.peakDb).toBeCloseTo(-6, 0);
    expect(Math.abs(r.summary.medianF0! - 440)).toBeLessThan(1);
    expect(r.summary.healthFlags).toEqual([]);
    expect(r.summary.spectralPeaks.length).toBeGreaterThan(0);
    // must be JSON-serializable (no Infinity/-Infinity anywhere)
    const json = JSON.stringify(r);
    expect(json).not.toContain('Infinity');
    expect(JSON.parse(json).summary.medianF0).toBeCloseTo(r.summary.medianF0!, 3);
  });

  it('silence serializes with null loudness, not -Infinity', () => {
    const r = buildReport({ samples: new Float32Array(SR / 10), sampleRate: SR });
    expect(r.summary.peakDb).toBeNull();
    expect(r.summary.medianF0).toBeNull();
    // the -Infinity → null mapping must reach the full envelope, not just the summary
    expect((r.envelope.peakDb as unknown)).toBeNull();
    expect((r.envelope.rmsDb as unknown)).toBeNull();
    for (const p of r.envelope.points) {
      expect((p.rmsDb as unknown)).toBeNull();
      expect((p.peakDb as unknown)).toBeNull();
    }
    const json = JSON.stringify(r);
    expect(json).not.toContain('Infinity');
    expect(json).not.toContain('NaN');
  });
});

describe('writeRunDir', () => {
  it('writes the full run directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'audio-lab-'));
    try {
      const dir = join(base, 'run1');
      const report = await writeRunDir({ dir, spec: { hello: 'world' }, clip: sine(440, 0.3) });
      const files = await readdir(dir);
      for (const f of ['report.json', 'render.wav', 'waveform.png', 'spectrogram.png', 'envelope.svg', 'pitch.svg', 'spec.json']) {
        expect(files, f).toContain(f);
      }
      const onDisk = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
      expect(onDisk.summary.sampleRate).toBe(SR);
      expect(report.summary.sampleRate).toBe(SR);
      expect(JSON.parse(await readFile(join(dir, 'spec.json'), 'utf8'))).toEqual({ hello: 'world' });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('defaultRunDir', () => {
  it('builds a timestamped path under .audio-lab/runs', () => {
    expect(defaultRunDir('mytest')).toMatch(/^\.audio-lab\/runs\/\d{8}-\d{6}-mytest$/);
  });
});

function sineClip(freq: number, seconds: number, sampleRate = 44100) {
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return { samples, sampleRate };
}

describe('report null-safety + new fields', () => {
  it('silent clip serializes envelope dB as null, not -Infinity', () => {
    const clip = { samples: new Float32Array(44100), sampleRate: 44100 };
    const r = buildReport(clip);
    expect(r.envelope.peakDb).toBeNull();
    expect(r.envelope.rmsDb).toBeNull();
    expect(r.envelope.points.every((p) => p.rmsDb === null && p.peakDb === null)).toBe(true);
    // must survive JSON round-trip without "null"-as-string or Infinity
    const round = JSON.parse(JSON.stringify(r));
    expect(round.envelope.peakDb).toBeNull();
  });

  it('spectrum block carries the per-frame centroid series and its hop', () => {
    const r = buildReport(sineClip(440, 1));
    expect(r.spectrum.hopSeconds).toBeGreaterThan(0);
    expect(r.spectrum.centroidHz.length).toBeGreaterThan(10);
    const mid = r.spectrum.centroidHz[Math.floor(r.spectrum.centroidHz.length / 2)];
    expect(mid).not.toBeNull();
  });

  it('summary.pitchSettle appears when noteTargets are given', () => {
    const clip = sineClip(220, 1);
    const r = buildReport(clip, { noteTargets: [{ time: 0, freq: 220 }] });
    expect(r.summary.pitchSettle).not.toBeNull();
    expect(r.summary.pitchSettle![0].targetHz).toBe(220);
    expect(r.summary.pitchSettle![0].settleSeconds).not.toBeNull();
    // and absent (null) when not given
    expect(buildReport(clip).summary.pitchSettle).toBeNull();
  });
});
