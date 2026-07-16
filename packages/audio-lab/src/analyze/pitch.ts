// Normalized-cross-correlation pitch tracker (autocorrelation family, YIN-ish).
// Per frame: correlate x[0..n) against x[lag..lag+n) for lag in [sr/fMax, sr/fMin],
// pick the best normalized correlation, refine the lag parabolically. A frame is
// unvoiced (f0 = null) when it is near-silent or the best correlation < 0.5.
import type { AudioClip } from '../types';

export interface PitchFrame { time: number; f0: number | null; confidence: number }

export interface PitchAnalysis {
  frames: PitchFrame[];
  medianF0: number | null;
  minF0: number | null;
  maxF0: number | null;
}

const CONFIDENCE_MIN = 0.5;
const SILENCE_RMS = 1e-3; // -60dBFS

export function analyzePitch(
  clip: AudioClip,
  opts: { fMin?: number; fMax?: number; hopSeconds?: number } = {},
): PitchAnalysis {
  const { samples, sampleRate } = clip;
  const fMin = opts.fMin ?? 50;
  const fMax = opts.fMax ?? 2000;
  const hopSeconds = opts.hopSeconds ?? 0.01;
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const lagMin = Math.max(2, Math.floor(sampleRate / fMax));
  const lagMax = Math.ceil(sampleRate / fMin);
  const n = lagMax; // correlation segment length: one full max-period
  const win = lagMax + n; // total window a frame needs

  const frames: PitchFrame[] = [];
  const f0s: number[] = [];

  for (let start = 0; start + win <= samples.length; start += hop) {
    const time = start / sampleRate;

    let sq = 0;
    for (let i = start; i < start + n; i++) sq += samples[i] * samples[i];
    if (Math.sqrt(sq / n) < SILENCE_RMS) {
      frames.push({ time, f0: null, confidence: 0 });
      continue;
    }

    let bestLag = -1;
    let bestR = -1;
    // energy of the shifted segment, updated incrementally per lag
    let energyB = 0;
    for (let i = start + lagMin; i < start + lagMin + n; i++) energyB += samples[i] * samples[i];
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += samples[start + i] * samples[start + lag + i];
      const r = dot / Math.sqrt(sq * energyB + 1e-12);
      if (r > bestR) {
        bestR = r;
        bestLag = lag;
      }
      // slide energyB window one sample right for the next lag
      const out = samples[start + lag];
      const inn = samples[start + lag + n];
      energyB += inn * inn - out * out;
    }

    if (bestR < CONFIDENCE_MIN || bestLag < 0) {
      frames.push({ time, f0: null, confidence: Math.max(0, bestR) });
      continue;
    }

    // Parabolic refinement around bestLag (recompute the two neighbors' r).
    const rAt = (lag: number): number => {
      if (lag < lagMin || lag > lagMax) return -1;
      let dot = 0;
      let eb = 0;
      for (let i = 0; i < n; i++) {
        dot += samples[start + i] * samples[start + lag + i];
        eb += samples[start + lag + i] * samples[start + lag + i];
      }
      return dot / Math.sqrt(sq * eb + 1e-12);
    };
    const rl = rAt(bestLag - 1);
    const rr = rAt(bestLag + 1);
    let lag = bestLag;
    const denom = rl - 2 * bestR + rr;
    if (rl >= 0 && rr >= 0 && Math.abs(denom) > 1e-12) {
      lag = bestLag + (0.5 * (rl - rr)) / denom;
    }

    const f0 = sampleRate / lag;
    frames.push({ time, f0, confidence: bestR });
    f0s.push(f0);
  }

  f0s.sort((a, b) => a - b);
  const medianF0 = f0s.length ? f0s[Math.floor(f0s.length / 2)] : null;
  return {
    frames,
    medianF0,
    minF0: f0s.length ? f0s[0] : null,
    maxF0: f0s.length ? f0s[f0s.length - 1] : null,
  };
}

/** First time ≥ fromTime at which f0 stays within `cents` of targetHz for
 *  `holdSeconds` of consecutive voiced frames. null if it never settles. */
export function pitchSettleTime(
  frames: PitchFrame[],
  fromTime: number,
  targetHz: number,
  cents = 25,
  holdSeconds = 0.05,
): number | null {
  const ratio = Math.pow(2, cents / 1200);
  const lo = targetHz / ratio;
  const hi = targetHz * ratio;
  let runStart: number | null = null;
  for (const f of frames) {
    if (f.time < fromTime) continue;
    const inBand = f.f0 !== null && f.f0 >= lo && f.f0 <= hi;
    if (inBand) {
      if (runStart === null) runStart = f.time;
      if (f.time - runStart >= holdSeconds) return runStart;
    } else {
      runStart = null;
    }
  }
  return null;
}
