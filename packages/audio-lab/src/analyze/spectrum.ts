// Hann-windowed STFT via fft.js. Produces a dB spectrogram, a time-averaged
// magnitude spectrum with its top peaks, and a per-frame spectral centroid.
import FFT from 'fft.js';
import type { AudioClip } from '../types';
import { db } from './envelope';

export interface SpectrogramData {
  frames: number;
  bins: number;
  db: Float32Array; // row-major [frame * bins + bin]
  minDb: number;
  maxDb: number;
}

export interface SpectralPeak { hz: number; db: number }

export interface SpectrumAnalysis {
  fftSize: number;
  hopSeconds: number;
  binHz: number;
  averageMagnitudeDb: number[];
  peaks: SpectralPeak[];
  centroidHz: (number | null)[];
  meanCentroidHz: number | null;
  spectrogram: SpectrogramData;
}

const DB_FLOOR = -100;
const SILENT_FRAME_MAG = 1e-6;
const N_PEAKS = 10;

export function analyzeSpectrum(
  clip: AudioClip,
  opts: { fftSize?: number; hopSeconds?: number } = {},
): SpectrumAnalysis {
  const { samples, sampleRate } = clip;
  const fftSize = opts.fftSize ?? 2048;
  const hopSeconds = opts.hopSeconds ?? 0.01;
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const bins = fftSize / 2;
  const binHz = sampleRate / fftSize;

  const fft = new FFT(fftSize);
  const complex = fft.createComplexArray();
  const windowed = new Array<number>(fftSize);
  const hann = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));

  const nFrames = Math.max(0, Math.floor((samples.length - fftSize) / hop) + 1);
  const specDb = new Float32Array(nFrames * bins);
  const avgMag = new Float64Array(bins);
  const centroidHz: (number | null)[] = [];
  let minDb = 0;
  let maxDb = DB_FLOOR;
  let centroidSum = 0;
  let centroidCount = 0;

  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) windowed[i] = samples[start + i] * hann[i];
    fft.realTransform(complex, windowed);
    fft.completeSpectrum(complex);

    let magSum = 0;
    let weighted = 0;
    for (let b = 0; b < bins; b++) {
      const re = complex[2 * b];
      const im = complex[2 * b + 1];
      const mag = Math.sqrt(re * re + im * im) / fftSize;
      avgMag[b] += mag;
      magSum += mag;
      weighted += mag * b * binHz;
      const d = Math.max(DB_FLOOR, db(mag));
      specDb[f * bins + b] = d;
      if (d < minDb) minDb = d;
      if (d > maxDb) maxDb = d;
    }

    if (magSum > SILENT_FRAME_MAG) {
      const c = weighted / magSum;
      centroidHz.push(c);
      centroidSum += c;
      centroidCount++;
    } else {
      centroidHz.push(null);
    }
  }

  const averageMagnitudeDb: number[] = [];
  for (let b = 0; b < bins; b++) {
    averageMagnitudeDb.push(Math.max(DB_FLOOR, db(avgMag[b] / Math.max(1, nFrames))));
  }

  // Local maxima of the average spectrum, loudest first.
  const peaks: SpectralPeak[] = [];
  for (let b = 1; b < bins - 1; b++) {
    if (
      averageMagnitudeDb[b] > averageMagnitudeDb[b - 1] &&
      averageMagnitudeDb[b] >= averageMagnitudeDb[b + 1] &&
      averageMagnitudeDb[b] > DB_FLOOR + 10
    ) {
      peaks.push({ hz: b * binHz, db: averageMagnitudeDb[b] });
    }
  }
  peaks.sort((a, b2) => b2.db - a.db);
  peaks.length = Math.min(peaks.length, N_PEAKS);

  return {
    fftSize,
    hopSeconds,
    binHz,
    averageMagnitudeDb,
    peaks,
    centroidHz,
    meanCentroidHz: centroidCount ? centroidSum / centroidCount : null,
    spectrogram: { frames: nFrames, bins, db: specDb, minDb, maxDb },
  };
}
