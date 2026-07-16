// Raster (pngjs) and SVG plot rendering. PNGs are what the agent opens with
// the Read tool; SVGs are compact and diff-able. Dark background throughout.
import { PNG } from 'pngjs';
import type { AudioClip } from '../types';
import type { EnvelopeAnalysis } from '../analyze/envelope';
import type { PitchAnalysis } from '../analyze/pitch';
import type { SpectrogramData } from '../analyze/spectrum';

const BG = { r: 16, g: 18, b: 24 };
const FG = { r: 96, g: 200, b: 255 };

function blank(width: number, height: number): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = BG.r;
    png.data[i + 1] = BG.g;
    png.data[i + 2] = BG.b;
    png.data[i + 3] = 255;
  }
  return png;
}

function setPx(png: PNG, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = 255;
}

export function waveformPng(
  clip: AudioClip,
  opts: { width?: number; height?: number } = {},
): Buffer {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 300;
  const png = blank(width, height);
  const { samples } = clip;
  const mid = height / 2;
  const perCol = samples.length / width;
  for (let x = 0; x < width; x++) {
    let min = 0;
    let max = 0;
    const from = Math.floor(x * perCol);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((x + 1) * perCol)));
    for (let i = from; i < to; i++) {
      const s = samples[i];
      if (Number.isFinite(s)) {
        if (s < min) min = s;
        if (s > max) max = s;
      }
    }
    const yTop = Math.round(mid - max * (mid - 2));
    const yBot = Math.round(mid - min * (mid - 2));
    for (let y = yTop; y <= yBot; y++) setPx(png, x, y, FG.r, FG.g, FG.b);
  }
  return PNG.sync.write(png);
}

// 5-stop dark-to-bright colormap (approx viridis) for spectrogram energy.
const STOPS: [number, number, number][] = [
  [13, 8, 65],
  [56, 89, 140],
  [31, 150, 139],
  [115, 208, 85],
  [253, 231, 37],
];

function colormap(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(c));
  const f = c - i;
  return [
    Math.round(STOPS[i][0] + (STOPS[i + 1][0] - STOPS[i][0]) * f),
    Math.round(STOPS[i][1] + (STOPS[i + 1][1] - STOPS[i][1]) * f),
    Math.round(STOPS[i][2] + (STOPS[i + 1][2] - STOPS[i][2]) * f),
  ];
}

export function spectrogramPng(
  spec: SpectrogramData,
  sampleRate: number,
  fftSize: number,
  opts: { width?: number; height?: number } = {},
): Buffer {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 400;
  const png = blank(width, height);
  if (spec.frames === 0) return PNG.sync.write(png);

  const binHz = sampleRate / fftSize;
  const fMin = 30;
  const fMax = sampleRate / 2;
  const lo = Math.max(spec.maxDb - 80, spec.minDb); // 80dB dynamic range
  const range = Math.max(1, spec.maxDb - lo);

  for (let y = 0; y < height; y++) {
    // log-frequency: top row = fMax, bottom row = fMin
    const freq = fMin * Math.pow(fMax / fMin, 1 - y / (height - 1));
    const bin = Math.min(spec.bins - 1, Math.max(0, Math.round(freq / binHz)));
    for (let x = 0; x < width; x++) {
      const frame = Math.min(spec.frames - 1, Math.floor((x / width) * spec.frames));
      const d = spec.db[frame * spec.bins + bin];
      const [r, g, b] = colormap((d - lo) / range);
      setPx(png, x, y, r, g, b);
    }
  }
  return PNG.sync.write(png);
}

interface SvgSeries { points: { x: number; y: number }[]; color: string; label: string }

function lineSvg(
  series: SvgSeries[],
  opts: { width?: number; height?: number; title: string; yLabel: string },
): string {
  const width = opts.width ?? 900;
  const height = opts.height ?? 260;
  const pad = 40;
  const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.y));
  const xMax = all.length ? Math.max(...all.map((p) => p.x)) : 1;
  const yMin = all.length ? Math.min(...all.map((p) => p.y)) : 0;
  const yMax = all.length ? Math.max(...all.map((p) => p.y)) : 1;
  const ySpan = yMax - yMin || 1;
  const px = (x: number) => pad + (x / (xMax || 1)) * (width - 2 * pad);
  const py = (y: number) => height - pad - ((y - yMin) / ySpan) * (height - 2 * pad);

  const lines = series
    .map((s) => {
      const pts = s.points
        .filter((p) => Number.isFinite(p.y))
        .map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
        .join(' ');
      return `<polyline fill="none" stroke="${s.color}" stroke-width="1.5" points="${pts}"/>`;
    })
    .join('\n  ');
  const legend = series
    .map((s, i) => `<text x="${pad + i * 140}" y="16" fill="${s.color}" font-size="12">${s.label}</text>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="background:#101218">
  <text x="${width / 2}" y="16" fill="#ccc" font-size="13" text-anchor="middle">${opts.title}</text>
  ${legend}
  <text x="6" y="${height / 2}" fill="#888" font-size="11" transform="rotate(-90 10 ${height / 2})">${opts.yLabel}</text>
  <text x="${pad}" y="${height - 6}" fill="#888" font-size="11">0s</text>
  <text x="${width - pad}" y="${height - 6}" fill="#888" font-size="11" text-anchor="end">${xMax.toFixed(2)}s</text>
  <text x="${pad - 4}" y="${py(yMax) + 4}" fill="#888" font-size="11" text-anchor="end">${yMax.toFixed(1)}</text>
  <text x="${pad - 4}" y="${py(yMin) + 4}" fill="#888" font-size="11" text-anchor="end">${yMin.toFixed(1)}</text>
  ${lines}
</svg>`;
}

export function envelopeSvg(env: EnvelopeAnalysis): string {
  const floor = -80;
  const clampDb = (d: number) => (Number.isFinite(d) ? Math.max(floor, d) : floor);
  return lineSvg(
    [
      {
        label: 'RMS dB',
        color: '#60c8ff',
        points: env.points.map((p) => ({ x: p.time, y: clampDb(p.rmsDb) })),
      },
      {
        label: 'Peak dB',
        color: '#ffb054',
        points: env.points.map((p) => ({ x: p.time, y: clampDb(p.peakDb) })),
      },
    ],
    { title: 'Envelope', yLabel: 'dBFS' },
  );
}

export function pitchSvg(pitch: PitchAnalysis): string {
  return lineSvg(
    [
      {
        label: 'f0 Hz',
        color: '#7dff9b',
        points: pitch.frames
          .filter((f) => f.f0 !== null)
          .map((f) => ({ x: f.time, y: f.f0 as number })),
      },
    ],
    { title: 'Pitch track (voiced frames only)', yLabel: 'Hz' },
  );
}
