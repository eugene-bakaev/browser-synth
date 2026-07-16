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
