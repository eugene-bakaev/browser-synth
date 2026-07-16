// Per-hop RMS/peak envelope + onset detection. Onset rule: a hop is an onset
// when its RMS is above -45dBFS and the previous hop was below -55dBFS (rise
// out of silence), with a 20ms refractory window. Attack = first onset to the
// max-peak hop; decay = max-peak hop to first hop 40dB below whole-clip peak.
import type { AudioClip } from '../types';

export const SILENCE_FLOOR_DB = -70;
const ONSET_ON_DB = -45;
const ONSET_OFF_DB = -55;
const REFRACTORY_S = 0.02;
const DECAY_DROP_DB = 40;

export function db(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

export interface EnvelopePoint { time: number; rmsDb: number; peakDb: number }

export interface EnvelopeAnalysis {
  hopSeconds: number;
  points: EnvelopePoint[];
  peakDb: number;
  rmsDb: number;
  onsets: number[];
  attackSeconds: number | null;
  decaySeconds: number | null;
}

export function analyzeEnvelope(clip: AudioClip, hopSeconds = 0.005): EnvelopeAnalysis {
  const { samples, sampleRate } = clip;
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const nHops = Math.floor(samples.length / hop);

  const points: EnvelopePoint[] = [];
  let clipPeak = 0;
  let sumSq = 0;
  for (let h = 0; h < nHops; h++) {
    let peak = 0;
    let sq = 0;
    for (let i = h * hop; i < (h + 1) * hop; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
      sq += samples[i] * samples[i];
    }
    if (peak > clipPeak) clipPeak = peak;
    sumSq += sq;
    points.push({ time: h * hopSeconds, rmsDb: db(Math.sqrt(sq / hop)), peakDb: db(peak) });
  }

  const onsets: number[] = [];
  for (let h = 0; h < nHops; h++) {
    const prevDb = h === 0 ? -Infinity : points[h - 1].rmsDb;
    if (points[h].rmsDb > ONSET_ON_DB && prevDb < ONSET_OFF_DB) {
      const t = points[h].time;
      if (onsets.length === 0 || t - onsets[onsets.length - 1] > REFRACTORY_S) onsets.push(t);
    }
  }

  const peakDb = db(clipPeak);
  let attackSeconds: number | null = null;
  let decaySeconds: number | null = null;
  if (onsets.length > 0 && peakDb > SILENCE_FLOOR_DB) {
    let maxHop = 0;
    for (let h = 1; h < nHops; h++) if (points[h].peakDb > points[maxHop].peakDb) maxHop = h;
    attackSeconds = Math.max(0, points[maxHop].time - onsets[0]);
    for (let h = maxHop + 1; h < nHops; h++) {
      if (points[h].peakDb < peakDb - DECAY_DROP_DB) {
        decaySeconds = points[h].time - points[maxHop].time;
        break;
      }
    }
  }

  return {
    hopSeconds,
    points,
    peakDb,
    rmsDb: db(Math.sqrt(sumSq / Math.max(1, nHops * hop))),
    onsets,
    attackSeconds,
    decaySeconds,
  };
}
