import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { waveformPng, spectrogramPng, envelopeSvg, pitchSvg } from './plots';
import { analyzeEnvelope } from '../analyze/envelope';
import { analyzePitch } from '../analyze/pitch';
import { analyzeSpectrum } from '../analyze/spectrum';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number): AudioClip {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

describe('plots', () => {
  const clip = sine(440, 0.5);

  it('waveformPng produces a decodable PNG of the right size with drawn content', () => {
    const png = PNG.sync.read(waveformPng(clip));
    expect(png.width).toBe(1200);
    expect(png.height).toBe(300);
    // some pixel in the middle row region differs from the background
    let drawn = 0;
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i] > 40) drawn++;
    expect(drawn).toBeGreaterThan(1000);
  });

  it('spectrogramPng produces a decodable PNG', () => {
    const s = analyzeSpectrum(clip);
    const png = PNG.sync.read(spectrogramPng(s.spectrogram, SR, s.fftSize));
    expect(png.width).toBe(1200);
    expect(png.height).toBe(400);
  });

  it('envelopeSvg and pitchSvg emit SVG with polylines', () => {
    const eSvg = envelopeSvg(analyzeEnvelope(clip));
    expect(eSvg).toContain('<svg');
    expect(eSvg).toContain('<polyline');
    const pSvg = pitchSvg(analyzePitch(clip));
    expect(pSvg).toContain('<svg');
    expect(pSvg).toContain('<polyline');
  });

  it('handles empty input without throwing', () => {
    const empty: AudioClip = { samples: new Float32Array(0), sampleRate: SR };
    expect(() => waveformPng(empty)).not.toThrow();
    expect(() => envelopeSvg(analyzeEnvelope(empty))).not.toThrow();
  });
});
