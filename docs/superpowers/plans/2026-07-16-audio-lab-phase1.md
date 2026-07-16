# Audio Lab Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev-only `packages/audio-lab` workspace that renders the five `*2` kernel engines offline in Node and produces agent-readable metrics (`report.json`), plots, and WAV files, plus a project skill documenting how to use it.

**Architecture:** Tier 1 of the approved spec `docs/superpowers/specs/2026-07-16-audio-lab-design.md`: kernels (`Synth2Kernel` etc.) are pure TS already runnable in Node — a renderer instantiates them exactly as the worklet entries do, then a pure-function analysis core (pitch/envelope/spectrum/health) turns samples into metrics, and a report writer assembles a run directory. A thin CLI dispatches it all. No client/server/shared code changes in this phase.

**Tech Stack:** TypeScript (strict, ESM, `moduleResolution: bundler`), Vitest, `tsx` (CLI runner, same as server), `fft.js` + `pngjs` (only pure-JS deps), hand-rolled WAV/SVG.

## Global Constraints

- Branch: work on `feat/audio-lab` (already created). Never commit on `main`.
- `packages/audio-lab` is dev-only: client/server/shared `package.json`, and everything under their `src/`, must NOT change in this phase.
- Merge gate: `npm run typecheck && npm test && npm run build` green at the end (audio-lab joins via `--workspaces --if-present`).
- Commit only files relevant to each task — never `git add -A`. Repo-root scratch files (`studio-focused.md`, `*.png`) must never be staged.
- Commit trailer (every commit):
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018Tyr1dtoyJ1XDC17VUHoBT
  ```
- All five kernels share this API (verified): `new XKernel(sampleRate)`, `applyParams(block: Float32Array)`, `noteOn(time, freq, duration, velocity[, mono])` with time/duration in **seconds from render start**, `process(out: Float32Array, frames, blockStartFrame)` in 128-frame blocks.
- Renders are NOT bit-identical run-to-run: kernels seed noise/S&H PRNGs from `Math.random()` per construction (by design — see memory `lfo-random-must-free-run`). Tests must assert with tolerances, never exact sample values, for noise-bearing content.
- Do not start or kill any dev servers; nothing in this phase needs one.

---

### Task 1: Workspace scaffold + WAV codec

**Files:**
- Create: `packages/audio-lab/package.json`
- Create: `packages/audio-lab/tsconfig.json`
- Create: `packages/audio-lab/vitest.config.ts`
- Create: `packages/audio-lab/src/types.ts`
- Create: `packages/audio-lab/src/report/wav.ts`
- Test: `packages/audio-lab/src/report/wav.test.ts`
- Modify: `package.json` (repo root — add `lab` script)
- Modify: `.gitignore` (repo root — add `.audio-lab/`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `AudioClip { samples: Float32Array; sampleRate: number }` and `DEFAULT_SAMPLE_RATE = 48000` from `src/types.ts`; `encodeWav(clip: AudioClip): Uint8Array` and `decodeWav(bytes: Uint8Array): AudioClip` from `src/report/wav.ts`. Every later task uses `AudioClip`.

- [ ] **Step 1: Create the workspace files**

`packages/audio-lab/package.json`:

```json
{
  "name": "@fiddle/audio-lab",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "lab": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fiddle/client": "*",
    "@fiddle/shared": "*",
    "fft.js": "^4.0.4",
    "pngjs": "^7.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pngjs": "^6.0.5",
    "tsx": "^4.19.0",
    "typescript": "^5.4.0",
    "vitest": "^4.1.7"
  }
}
```

`packages/audio-lab/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`packages/audio-lab/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
```

`packages/audio-lab/src/types.ts`:

```ts
// Shared sample-buffer shape for the whole lab: every renderer produces it,
// every analyzer consumes it. Mono by contract in Phase 1 (kernels are mono;
// Tier 2 stereo is a spec-deferred follow-up).
export interface AudioClip {
  samples: Float32Array;
  sampleRate: number;
}

export const DEFAULT_SAMPLE_RATE = 48000;
```

Root `package.json` — add to `"scripts"` (keep all existing entries):

```json
    "lab": "npm run lab -w @fiddle/audio-lab --",
```

Root `.gitignore` — append:

```
# audio-lab run outputs
.audio-lab/
```

- [ ] **Step 2: Install to link the workspace**

Run from repo root: `npm install`
Expected: exits 0; `packages/audio-lab/node_modules` (or hoisted root `node_modules`) now contains symlinks `@fiddle/client`, `@fiddle/shared`, plus `tsx`, `fft.js`, `pngjs`, `vitest`.

- [ ] **Step 3: Write the failing WAV round-trip test**

`packages/audio-lab/src/report/wav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeWav, decodeWav } from './wav';
import type { AudioClip } from '../types';

function sine(freq: number, seconds: number, sampleRate: number, amp = 0.5): AudioClip {
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return { samples, sampleRate };
}

describe('wav codec', () => {
  it('round-trips a mono 16-bit clip within quantization error', () => {
    const clip = sine(440, 0.1, 48000);
    const bytes = encodeWav(clip);
    // RIFF header sanity
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF');
    expect(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])).toBe('WAVE');
    expect(bytes.length).toBe(44 + clip.samples.length * 2);

    const back = decodeWav(bytes);
    expect(back.sampleRate).toBe(48000);
    expect(back.samples.length).toBe(clip.samples.length);
    for (let i = 0; i < clip.samples.length; i += 97) {
      expect(Math.abs(back.samples[i] - clip.samples[i])).toBeLessThan(1 / 32000);
    }
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const clip: AudioClip = { samples: new Float32Array([1.5, -1.5]), sampleRate: 48000 };
    const back = decodeWav(encodeWav(clip));
    expect(back.samples[0]).toBeGreaterThan(0.99);
    expect(back.samples[1]).toBeLessThan(-0.99);
  });

  it('rejects non-PCM16-mono files', () => {
    const bytes = encodeWav(sine(440, 0.01, 48000));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(22, 2, true); // pretend stereo
    expect(() => decodeWav(bytes)).toThrow(/mono/i);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/report/wav.test.ts`
Expected: FAIL — cannot resolve `./wav`.

- [ ] **Step 5: Implement the codec**

`packages/audio-lab/src/report/wav.ts`:

```ts
// Hand-rolled 16-bit PCM mono WAV, little-endian. 44-byte canonical header on
// encode; decode walks chunks so files with extra chunks (LIST etc.) still load.
import type { AudioClip } from '../types';

export function encodeWav(clip: AudioClip): Uint8Array {
  const { samples, sampleRate } = clip;
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);      // fmt chunk size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes: Uint8Array): AudioClip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (off: number, len: number) =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('not a WAV file');

  let sampleRate = 0;
  let samples: Float32Array | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      const format = view.getUint16(off + 8, true);
      const channels = view.getUint16(off + 10, true);
      const bits = view.getUint16(off + 22, true);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error('only PCM 16-bit mono WAV is supported');
      }
      sampleRate = view.getUint32(off + 12, true);
    } else if (id === 'data') {
      const n = Math.floor(size / 2);
      samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = view.getInt16(off + 8 + i * 2, true);
        samples[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
      }
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!sampleRate || !samples) throw new Error('WAV missing fmt or data chunk');
  return { samples, sampleRate };
}
```

- [ ] **Step 6: Run tests + typecheck to verify they pass**

Run: `npm test -w @fiddle/audio-lab` then `npm run typecheck -w @fiddle/audio-lab`
Expected: 3 tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/audio-lab package.json .gitignore package-lock.json
git commit -m "feat(audio-lab): workspace scaffold + WAV codec"
```

---

### Task 2: Envelope analysis

**Files:**
- Create: `packages/audio-lab/src/analyze/envelope.ts`
- Test: `packages/audio-lab/src/analyze/envelope.test.ts`

**Interfaces:**
- Consumes: `AudioClip` from `../types`.
- Produces:
  ```ts
  interface EnvelopePoint { time: number; rmsDb: number; peakDb: number }
  interface EnvelopeAnalysis {
    hopSeconds: number;
    points: EnvelopePoint[];
    peakDb: number;             // whole-clip peak
    rmsDb: number;              // whole-clip RMS
    onsets: number[];           // seconds
    attackSeconds: number | null;
    decaySeconds: number | null;
  }
  function analyzeEnvelope(clip: AudioClip, hopSeconds?: number): EnvelopeAnalysis // default 0.005
  const SILENCE_FLOOR_DB = -70;
  function db(x: number): number  // 20*log10, -Infinity-safe (exported helper, reused by health/report)
  ```

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/analyze/envelope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { analyzeEnvelope, db } from './envelope';
import type { AudioClip } from '../types';

const SR = 48000;

/** silence, then a sine burst with a sharp start, then silence again. */
function burstClip(bursts: { start: number; dur: number; amp: number }[], total: number): AudioClip {
  const samples = new Float32Array(Math.round(total * SR));
  for (const b of bursts) {
    const s = Math.round(b.start * SR);
    const n = Math.round(b.dur * SR);
    for (let i = 0; i < n; i++) {
      samples[s + i] = b.amp * Math.sin((2 * Math.PI * 440 * i) / SR);
    }
  }
  return { samples, sampleRate: SR };
}

describe('analyzeEnvelope', () => {
  it('reports whole-clip peak and per-hop points', () => {
    const clip = burstClip([{ start: 0.2, dur: 0.3, amp: 0.5 }], 1.0);
    const env = analyzeEnvelope(clip);
    expect(env.peakDb).toBeCloseTo(db(0.5), 0);
    expect(env.points.length).toBe(Math.floor(clip.samples.length / Math.round(0.005 * SR)));
    // a hop inside the burst is loud; one inside leading silence is at the floor
    expect(env.points[Math.round(0.3 / 0.005)].rmsDb).toBeGreaterThan(-12);
    expect(env.points[10].rmsDb).toBe(-Infinity);
  });

  it('detects one onset per burst at the right time', () => {
    const clip = burstClip(
      [{ start: 0.2, dur: 0.2, amp: 0.5 }, { start: 0.6, dur: 0.2, amp: 0.5 }],
      1.0,
    );
    const env = analyzeEnvelope(clip);
    expect(env.onsets.length).toBe(2);
    expect(env.onsets[0]).toBeGreaterThan(0.18);
    expect(env.onsets[0]).toBeLessThan(0.22);
    expect(env.onsets[1]).toBeGreaterThan(0.58);
    expect(env.onsets[1]).toBeLessThan(0.62);
  });

  it('measures decay time to -40dB below peak', () => {
    // 0.5s exponential decay from amp 0.8 with tau=0.05s: -40dB at t≈0.23s
    const n = Math.round(0.5 * SR);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.8 * Math.exp(-i / SR / 0.05) * Math.sin((2 * Math.PI * 200 * i) / SR);
    }
    const env = analyzeEnvelope({ samples, sampleRate: SR });
    expect(env.decaySeconds).not.toBeNull();
    expect(env.decaySeconds!).toBeGreaterThan(0.15);
    expect(env.decaySeconds!).toBeLessThan(0.3);
  });

  it('returns null attack/decay for silence and finds no onsets', () => {
    const env = analyzeEnvelope({ samples: new Float32Array(SR), sampleRate: SR });
    expect(env.onsets).toEqual([]);
    expect(env.attackSeconds).toBeNull();
    expect(env.decaySeconds).toBeNull();
    expect(env.peakDb).toBe(-Infinity);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/envelope.test.ts`
Expected: FAIL — cannot resolve `./envelope`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/analyze/envelope.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/envelope.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/analyze
git commit -m "feat(audio-lab): envelope analysis (RMS/peak, onsets, attack/decay)"
```

---

### Task 3: Pitch analysis

**Files:**
- Create: `packages/audio-lab/src/analyze/pitch.ts`
- Test: `packages/audio-lab/src/analyze/pitch.test.ts`

**Interfaces:**
- Consumes: `AudioClip`.
- Produces:
  ```ts
  interface PitchFrame { time: number; f0: number | null; confidence: number }
  interface PitchAnalysis {
    frames: PitchFrame[];
    medianF0: number | null;
    minF0: number | null;
    maxF0: number | null;
  }
  function analyzePitch(clip: AudioClip, opts?: { fMin?: number; fMax?: number; hopSeconds?: number }): PitchAnalysis
  // defaults: fMin 40, fMax 2000, hopSeconds 0.01
  function pitchSettleTime(frames: PitchFrame[], fromTime: number, targetHz: number, cents?: number, holdSeconds?: number): number | null
  // defaults: cents 25, holdSeconds 0.05. THE portamento metric: first time ≥ fromTime
  // where f0 stays within `cents` of targetHz for holdSeconds.
  ```

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/analyze/pitch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { analyzePitch, pitchSettleTime } from './pitch';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 0.5): AudioClip {
  const n = Math.round(seconds * SR);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

/** Linear glide from f0 to f1 over `glide` seconds, then holds f1. Phase-continuous. */
function glideClip(f0: number, f1: number, glide: number, total: number): AudioClip {
  const n = Math.round(total * SR);
  const samples = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = t >= glide ? f1 : f0 + ((f1 - f0) * t) / glide;
    phase += (2 * Math.PI * f) / SR;
    samples[i] = 0.5 * Math.sin(phase);
  }
  return { samples, sampleRate: SR };
}

describe('analyzePitch', () => {
  it('tracks a steady 440Hz sine within 1Hz', () => {
    const p = analyzePitch(sine(440, 1.0));
    expect(p.medianF0).not.toBeNull();
    expect(Math.abs(p.medianF0! - 440)).toBeLessThan(1);
    const voiced = p.frames.filter((f) => f.f0 !== null);
    expect(voiced.length).toBeGreaterThan(80);
    for (const f of voiced) expect(f.confidence).toBeGreaterThan(0.8);
  });

  it('returns null f0 for silence', () => {
    const p = analyzePitch({ samples: new Float32Array(SR), sampleRate: SR });
    expect(p.medianF0).toBeNull();
    expect(p.frames.every((f) => f.f0 === null)).toBe(true);
  });

  it('follows a 220→440 glide', () => {
    const p = analyzePitch(glideClip(220, 440, 0.5, 1.0));
    const at = (t: number) =>
      p.frames.reduce((best, f) => (Math.abs(f.time - t) < Math.abs(best.time - t) ? f : best));
    expect(Math.abs(at(0.08)!.f0! - 220 - (440 - 220) * (0.08 / 0.5))).toBeLessThan(15);
    expect(Math.abs(at(0.8)!.f0! - 440)).toBeLessThan(3);
    expect(p.minF0!).toBeLessThan(240);
    expect(p.maxF0!).toBeGreaterThan(420);
  });
});

describe('pitchSettleTime', () => {
  it('measures when a glide reaches its target', () => {
    const p = analyzePitch(glideClip(220, 440, 0.4, 1.0));
    const settle = pitchSettleTime(p.frames, 0, 440);
    expect(settle).not.toBeNull();
    expect(settle!).toBeGreaterThan(0.3);
    expect(settle!).toBeLessThan(0.5);
  });

  it('is ~immediate when there is no glide', () => {
    const p = analyzePitch(sine(440, 0.5));
    const settle = pitchSettleTime(p.frames, 0, 440);
    expect(settle).not.toBeNull();
    expect(settle!).toBeLessThan(0.08);
  });

  it('returns null when the target is never reached', () => {
    const p = analyzePitch(sine(220, 0.5));
    expect(pitchSettleTime(p.frames, 0, 440)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/pitch.test.ts`
Expected: FAIL — cannot resolve `./pitch`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/analyze/pitch.ts`:

```ts
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
  const fMin = opts.fMin ?? 40;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/pitch.test.ts`
Expected: 6 tests PASS. (The tracker is O(lagMax·n) per frame — ~1s clips analyze in well under a second; if the suite is slow later, tighten fMin per call site, not here.)

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/analyze/pitch.ts packages/audio-lab/src/analyze/pitch.test.ts
git commit -m "feat(audio-lab): pitch tracking (NCC autocorrelation) + settle-time metric"
```

---

### Task 4: Spectrum analysis

**Files:**
- Create: `packages/audio-lab/src/analyze/spectrum.ts`
- Create: `packages/audio-lab/src/fft.d.ts`
- Test: `packages/audio-lab/src/analyze/spectrum.test.ts`

**Interfaces:**
- Consumes: `AudioClip`; `fft.js` (dep installed in Task 1).
- Produces:
  ```ts
  interface SpectrogramData { frames: number; bins: number; db: Float32Array /* row-major [frame*bins+bin] */; minDb: number; maxDb: number }
  interface SpectralPeak { hz: number; db: number }
  interface SpectrumAnalysis {
    fftSize: number;            // default 2048
    hopSeconds: number;         // default 0.01
    binHz: number;              // sampleRate / fftSize
    averageMagnitudeDb: number[];        // fftSize/2 bins, dB, time-averaged
    peaks: SpectralPeak[];               // top-10 local maxima of the average spectrum
    centroidHz: (number | null)[];       // per frame (null = near-silent frame)
    meanCentroidHz: number | null;
    spectrogram: SpectrogramData;
  }
  function analyzeSpectrum(clip: AudioClip, opts?: { fftSize?: number; hopSeconds?: number }): SpectrumAnalysis
  ```

- [ ] **Step 1: Write the fft.js type declaration**

`packages/audio-lab/src/fft.d.ts`:

```ts
declare module 'fft.js' {
  export default class FFT {
    constructor(size: number);
    createComplexArray(): number[];
    realTransform(output: number[], input: ArrayLike<number>): void;
    completeSpectrum(spectrum: number[]): void;
  }
}
```

- [ ] **Step 2: Write the failing test**

`packages/audio-lab/src/analyze/spectrum.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { analyzeSpectrum } from './spectrum';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 0.5): AudioClip {
  const n = Math.round(seconds * SR);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

describe('analyzeSpectrum', () => {
  it('puts the top spectral peak at the sine frequency', () => {
    const s = analyzeSpectrum(sine(440, 0.5));
    expect(s.binHz).toBeCloseTo(SR / 2048, 5);
    expect(s.peaks.length).toBeGreaterThan(0);
    expect(Math.abs(s.peaks[0].hz - 440)).toBeLessThanOrEqual(s.binHz);
  });

  it('centroid of a pure sine sits near the sine frequency', () => {
    const s = analyzeSpectrum(sine(440, 0.5));
    expect(s.meanCentroidHz).not.toBeNull();
    expect(Math.abs(s.meanCentroidHz! - 440)).toBeLessThan(40);
  });

  it('a brighter signal has a higher centroid', () => {
    const low = analyzeSpectrum(sine(200, 0.5)).meanCentroidHz!;
    const high = analyzeSpectrum(sine(2000, 0.5)).meanCentroidHz!;
    expect(high).toBeGreaterThan(low * 3);
  });

  it('spectrogram has the expected shape and silent frames are null-centroid', () => {
    const clip = sine(440, 0.3);
    const s = analyzeSpectrum(clip);
    expect(s.spectrogram.bins).toBe(1024);
    expect(s.spectrogram.frames).toBe(s.centroidHz.length);
    expect(s.spectrogram.db.length).toBe(s.spectrogram.frames * s.spectrogram.bins);

    const silent = analyzeSpectrum({ samples: new Float32Array(SR / 2), sampleRate: SR });
    expect(silent.meanCentroidHz).toBeNull();
    expect(silent.centroidHz.every((c) => c === null)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/spectrum.test.ts`
Expected: FAIL — cannot resolve `./spectrum`.

- [ ] **Step 4: Implement**

`packages/audio-lab/src/analyze/spectrum.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/spectrum.test.ts` then `npm run typecheck -w @fiddle/audio-lab`
Expected: 4 tests PASS; typecheck exits 0 (proves `fft.d.ts` is picked up).

- [ ] **Step 6: Commit**

```bash
git add packages/audio-lab/src/analyze/spectrum.ts packages/audio-lab/src/analyze/spectrum.test.ts packages/audio-lab/src/fft.d.ts
git commit -m "feat(audio-lab): STFT spectrum analysis (spectrogram, centroid, peaks)"
```

---

### Task 5: Health checks

**Files:**
- Create: `packages/audio-lab/src/analyze/health.ts`
- Test: `packages/audio-lab/src/analyze/health.test.ts`

**Interfaces:**
- Consumes: `AudioClip`; `SILENCE_FLOOR_DB`, `db` from `./envelope`.
- Produces:
  ```ts
  interface HealthReport {
    clippedSamples: number;        // |x| >= 0.999
    nonFiniteSamples: number;      // NaN / Infinity
    dcOffset: number;              // mean sample value
    longestSilenceSeconds: number; // longest run of sub -70dBFS 5ms hops
    flags: string[];               // 'CLIPPING' | 'NON_FINITE' | 'DC_OFFSET' | 'MOSTLY_SILENT'
  }
  function analyzeHealth(clip: AudioClip): HealthReport
  ```

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/analyze/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { analyzeHealth } from './health';
import type { AudioClip } from '../types';

const SR = 48000;

function clipOf(fill: (i: number) => number, seconds = 0.5): AudioClip {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = fill(i);
  return { samples, sampleRate: SR };
}

describe('analyzeHealth', () => {
  it('clean sine has no flags', () => {
    const h = analyzeHealth(clipOf((i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)));
    expect(h.clippedSamples).toBe(0);
    expect(h.nonFiniteSamples).toBe(0);
    expect(Math.abs(h.dcOffset)).toBeLessThan(0.001);
    expect(h.flags).toEqual([]);
  });

  it('counts clipped and non-finite samples and flags them', () => {
    const samples = new Float32Array(SR);
    samples.fill(0.5);
    samples[100] = 1.0;
    samples[200] = -1.0;
    samples[300] = NaN;
    samples[400] = Infinity;
    const h = analyzeHealth({ samples, sampleRate: SR });
    expect(h.clippedSamples).toBe(2);
    expect(h.nonFiniteSamples).toBe(2);
    expect(h.flags).toContain('CLIPPING');
    expect(h.flags).toContain('NON_FINITE');
  });

  it('flags DC offset', () => {
    const h = analyzeHealth(clipOf(() => 0.1));
    expect(h.dcOffset).toBeCloseTo(0.1, 3);
    expect(h.flags).toContain('DC_OFFSET');
  });

  it('measures longest silence and flags a mostly-silent clip', () => {
    // 1s clip: sound only in the first 0.1s
    const h = analyzeHealth(
      clipOf((i) => (i < 0.1 * SR ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0), 1.0),
    );
    expect(h.longestSilenceSeconds).toBeGreaterThan(0.85);
    expect(h.flags).toContain('MOSTLY_SILENT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/health.test.ts`
Expected: FAIL — cannot resolve `./health`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/analyze/health.ts`:

```ts
// Sanity metrics an agent checks before trusting any other number: a render
// with NON_FINITE or MOSTLY_SILENT flags means the patch (or the DSP) is
// broken, not that the feature under test misbehaved.
import type { AudioClip } from '../types';
import { SILENCE_FLOOR_DB, db } from './envelope';

export interface HealthReport {
  clippedSamples: number;
  nonFiniteSamples: number;
  dcOffset: number;
  longestSilenceSeconds: number;
  flags: string[];
}

const CLIP_LEVEL = 0.999;
const DC_FLAG_LEVEL = 0.01;
const SILENCE_HOP_S = 0.005;
const MOSTLY_SILENT_RATIO = 0.9;

export function analyzeHealth(clip: AudioClip): HealthReport {
  const { samples, sampleRate } = clip;
  let clipped = 0;
  let nonFinite = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s)) {
      nonFinite++;
      continue;
    }
    if (Math.abs(s) >= CLIP_LEVEL) clipped++;
    sum += s;
  }
  const finiteCount = samples.length - nonFinite;
  const dcOffset = finiteCount ? sum / finiteCount : 0;

  const hop = Math.max(1, Math.round(SILENCE_HOP_S * sampleRate));
  let longestRun = 0;
  let run = 0;
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let sq = 0;
    for (let i = start; i < start + hop; i++) {
      const s = samples[i];
      if (Number.isFinite(s)) sq += s * s;
    }
    if (db(Math.sqrt(sq / hop)) < SILENCE_FLOOR_DB) {
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  const longestSilenceSeconds = longestRun * SILENCE_HOP_S;
  const durationSeconds = samples.length / sampleRate;

  const flags: string[] = [];
  if (clipped > 0) flags.push('CLIPPING');
  if (nonFinite > 0) flags.push('NON_FINITE');
  if (Math.abs(dcOffset) > DC_FLAG_LEVEL) flags.push('DC_OFFSET');
  if (durationSeconds > 0 && longestSilenceSeconds / durationSeconds > MOSTLY_SILENT_RATIO) {
    flags.push('MOSTLY_SILENT');
  }

  return { clippedSamples: clipped, nonFiniteSamples: nonFinite, dcOffset, longestSilenceSeconds, flags };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/health.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/analyze/health.ts packages/audio-lab/src/analyze/health.test.ts
git commit -m "feat(audio-lab): health checks (clipping, DC, silence, non-finite)"
```

---

### Task 6: Tier 1 kernel renderer

**Files:**
- Create: `packages/audio-lab/src/render/engine.ts`
- Test: `packages/audio-lab/src/render/engine.test.ts`

**Interfaces:**
- Consumes: kernel classes + param modules deep-imported from `@fiddle/client/src/engine/<name>/kernel/…` (works because `@fiddle/client` has no `exports` field and `moduleResolution: bundler` resolves the symlinked `.ts` sources — same pattern the server uses for `@fiddle/shared`); `MOD_SOURCES` from `@fiddle/shared`; `AudioClip`, `DEFAULT_SAMPLE_RATE` from `../types`.
- Produces:
  ```ts
  type EngineId = 'synth2' | 'kick2' | 'hat2' | 'snare2' | 'clap2';
  const ENGINE_IDS: EngineId[];
  interface NoteEvent { time: number; note?: string; freq?: number; duration: number; velocity?: number; mono?: boolean }
  interface MatrixRoute { source: string; dest: string; amount: number }
  interface EngineRenderSpec {
    engine: EngineId;
    params?: Record<string, number>;
    matrix?: MatrixRoute[];       // synth2 only
    notes: NoteEvent[];
    seconds: number;
    sampleRate?: number;
  }
  function renderEngine(spec: EngineRenderSpec): AudioClip
  function noteToFreq(name: string): number  // 'A4' → 440, 'C#3', 'Eb2', …
  ```

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/render/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderEngine, noteToFreq, ENGINE_IDS } from './engine';
import { analyzeEnvelope } from '../analyze/envelope';
import { analyzePitch } from '../analyze/pitch';
import { analyzeHealth } from '../analyze/health';

describe('noteToFreq', () => {
  it('maps note names to equal-temperament frequencies', () => {
    expect(noteToFreq('A4')).toBeCloseTo(440, 2);
    expect(noteToFreq('C4')).toBeCloseTo(261.63, 1);
    expect(noteToFreq('C#3')).toBeCloseTo(138.59, 1);
    expect(noteToFreq('Eb2')).toBeCloseTo(77.78, 1);
    expect(() => noteToFreq('H4')).toThrow(/note/i);
  });
});

describe('renderEngine', () => {
  it('renders a synth2 note: audible, in tune, healthy', () => {
    const clip = renderEngine({
      engine: 'synth2',
      notes: [{ time: 0, note: 'A3', duration: 0.5 }],
      seconds: 1,
    });
    expect(clip.samples.length).toBe(48000);
    const health = analyzeHealth(clip);
    expect(health.nonFiniteSamples).toBe(0);
    expect(health.flags).not.toContain('MOSTLY_SILENT');
    const env = analyzeEnvelope(clip);
    expect(env.onsets.length).toBeGreaterThanOrEqual(1);
    expect(env.onsets[0]).toBeLessThan(0.03);
    const pitch = analyzePitch(clip);
    expect(pitch.medianF0).not.toBeNull();
    // default patch may be detuned/rich; just require the right octave region
    expect(pitch.medianF0!).toBeGreaterThan(180);
    expect(pitch.medianF0!).toBeLessThan(260);
  });

  it('places a kick2 hit at the scheduled time', () => {
    const clip = renderEngine({
      engine: 'kick2',
      notes: [{ time: 0.25, note: 'C2', duration: 0.1 }],
      seconds: 1,
    });
    const env = analyzeEnvelope(clip);
    expect(env.onsets.length).toBe(1);
    expect(env.onsets[0]).toBeGreaterThan(0.23);
    expect(env.onsets[0]).toBeLessThan(0.27);
  });

  it('every engine renders its default patch without NaN or total silence', () => {
    for (const engine of ENGINE_IDS) {
      const clip = renderEngine({
        engine,
        notes: [{ time: 0, note: 'A3', duration: 0.3 }],
        seconds: 0.8,
      });
      const health = analyzeHealth(clip);
      expect(health.nonFiniteSamples, engine).toBe(0);
      expect(health.flags, engine).not.toContain('MOSTLY_SILENT');
    }
  });

  it('applies param overrides and rejects unknown keys with the valid list', () => {
    // filter.cutoff must exist on synth2 (descriptor wire key)
    const dark = renderEngine({
      engine: 'synth2',
      params: { 'filter.cutoff': 200 },
      notes: [{ time: 0, note: 'A3', duration: 0.4 }],
      seconds: 1,
    });
    expect(analyzeHealth(dark).flags).not.toContain('MOSTLY_SILENT');
    expect(() =>
      renderEngine({ engine: 'synth2', params: { nonsense: 1 }, notes: [], seconds: 0.1 }),
    ).toThrow(/Unknown param 'nonsense'.*filter\.cutoff/s);
  });

  it('wires synth2 matrix routes and rejects them for other engines', () => {
    const wobble = renderEngine({
      engine: 'synth2',
      matrix: [{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.8 }],
      notes: [{ time: 0, note: 'A2', duration: 1.5 }],
      seconds: 2,
    });
    expect(analyzeHealth(wobble).nonFiniteSamples).toBe(0);
    expect(() =>
      renderEngine({
        engine: 'kick2',
        matrix: [{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.5 }],
        notes: [],
        seconds: 0.1,
      }),
    ).toThrow(/matrix/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/render/engine.test.ts`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/render/engine.ts`:

```ts
// Tier 1 renderer: instantiates the *2 kernels exactly as their worklet
// entries do (packages/client/src/engine/<name>/worklet-entry.ts) and renders
// in the same 128-frame blocks. Times are seconds from render start; the
// kernels convert to frames internally (noteOn rounds t * sampleRate).
import { Synth2Kernel } from '@fiddle/client/src/engine/synth2/kernel/Synth2Kernel';
import {
  PARAM_INDEX as SYNTH2_PARAM_INDEX,
  defaultParamBlock as synth2DefaultBlock,
  MATRIX_BASE,
  MATRIX_SLOTS,
  MATRIX_STRIDE,
} from '@fiddle/client/src/engine/synth2/kernel/params';
import { Kick2Kernel } from '@fiddle/client/src/engine/kick2/kernel/Kick2Kernel';
import {
  PARAM_INDEX as KICK2_PARAM_INDEX,
  defaultParamBlock as kick2DefaultBlock,
} from '@fiddle/client/src/engine/kick2/kernel/params';
import { Hat2Kernel } from '@fiddle/client/src/engine/hat2/kernel/Hat2Kernel';
import {
  PARAM_INDEX as HAT2_PARAM_INDEX,
  defaultParamBlock as hat2DefaultBlock,
} from '@fiddle/client/src/engine/hat2/kernel/params';
import { Snare2Kernel } from '@fiddle/client/src/engine/snare2/kernel/Snare2Kernel';
import {
  PARAM_INDEX as SNARE2_PARAM_INDEX,
  defaultParamBlock as snare2DefaultBlock,
} from '@fiddle/client/src/engine/snare2/kernel/params';
import { Clap2Kernel } from '@fiddle/client/src/engine/clap2/kernel/Clap2Kernel';
import {
  PARAM_INDEX as CLAP2_PARAM_INDEX,
  defaultParamBlock as clap2DefaultBlock,
} from '@fiddle/client/src/engine/clap2/kernel/params';
import { MOD_SOURCES } from '@fiddle/shared';
import type { AudioClip } from '../types';
import { DEFAULT_SAMPLE_RATE } from '../types';

const BLOCK = 128;

export type EngineId = 'synth2' | 'kick2' | 'hat2' | 'snare2' | 'clap2';
export const ENGINE_IDS: EngineId[] = ['synth2', 'kick2', 'hat2', 'snare2', 'clap2'];

export interface NoteEvent {
  time: number;          // seconds from render start
  note?: string;         // 'A3' — used when freq is absent
  freq?: number;         // Hz, wins over note
  duration: number;      // gate seconds
  velocity?: number;     // 0..1, default 1
  mono?: boolean;        // synth2 voice allocation; default false (poly)
}

export interface MatrixRoute { source: string; dest: string; amount: number }

export interface EngineRenderSpec {
  engine: EngineId;
  params?: Record<string, number>;
  matrix?: MatrixRoute[];
  notes: NoteEvent[];
  seconds: number;
  sampleRate?: number;
}

interface KernelInstance {
  applyParams(block: Float32Array): void;
  noteOn(time: number, freq: number, duration: number, velocity: number, mono?: boolean): void;
  process(out: Float32Array, frames: number, blockStartFrame: number): void;
}

interface EngineDef {
  create(sampleRate: number): KernelInstance;
  paramIndex: Readonly<Record<string, number>>;
  defaultBlock(): Float32Array;
  supportsMatrix: boolean;
}

const ENGINES: Record<EngineId, EngineDef> = {
  synth2: {
    create: (sr) => new Synth2Kernel(sr),
    paramIndex: SYNTH2_PARAM_INDEX,
    defaultBlock: synth2DefaultBlock,
    supportsMatrix: true,
  },
  kick2: {
    create: (sr) => new Kick2Kernel(sr),
    paramIndex: KICK2_PARAM_INDEX,
    defaultBlock: kick2DefaultBlock,
    supportsMatrix: false,
  },
  hat2: {
    create: (sr) => new Hat2Kernel(sr),
    paramIndex: HAT2_PARAM_INDEX,
    defaultBlock: hat2DefaultBlock,
    supportsMatrix: false,
  },
  snare2: {
    create: (sr) => new Snare2Kernel(sr),
    paramIndex: SNARE2_PARAM_INDEX,
    defaultBlock: snare2DefaultBlock,
    supportsMatrix: false,
  },
  clap2: {
    create: (sr) => new Clap2Kernel(sr),
    paramIndex: CLAP2_PARAM_INDEX,
    defaultBlock: clap2DefaultBlock,
    supportsMatrix: false,
  },
};

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteToFreq(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`invalid note name '${name}' (expected e.g. A3, C#4, Eb2)`);
  let semi = SEMITONES[m[1].toUpperCase()];
  if (m[2] === '#') semi += 1;
  if (m[2] === 'b') semi -= 1;
  const midi = (parseInt(m[3], 10) + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function renderEngine(spec: EngineRenderSpec): AudioClip {
  const def = ENGINES[spec.engine];
  if (!def) throw new Error(`unknown engine '${spec.engine}'. Valid: ${ENGINE_IDS.join(', ')}`);
  const sampleRate = spec.sampleRate ?? DEFAULT_SAMPLE_RATE;

  const block = def.defaultBlock();
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    const idx = def.paramIndex[key];
    if (idx === undefined) {
      throw new Error(
        `Unknown param '${key}' for ${spec.engine}. Valid keys:\n${Object.keys(def.paramIndex).join(', ')}`,
      );
    }
    block[idx] = value;
  }

  if (spec.matrix && spec.matrix.length > 0) {
    if (!def.supportsMatrix) throw new Error(`engine '${spec.engine}' has no mod matrix`);
    if (spec.matrix.length > MATRIX_SLOTS) {
      throw new Error(`too many matrix routes (max ${MATRIX_SLOTS})`);
    }
    spec.matrix.forEach((route, slot) => {
      const srcIdx = MOD_SOURCES.indexOf(route.source as (typeof MOD_SOURCES)[number]);
      if (srcIdx < 0) {
        throw new Error(`unknown matrix source '${route.source}'. Valid: ${MOD_SOURCES.join(', ')}`);
      }
      const destIdx = def.paramIndex[route.dest];
      if (destIdx === undefined) {
        throw new Error(`unknown matrix dest '${route.dest}' for ${spec.engine}`);
      }
      const base = MATRIX_BASE + slot * MATRIX_STRIDE;
      block[base] = srcIdx;
      block[base + 1] = destIdx + 1; // destEnc: 0 = off, else PARAM_INDEX + 1
      block[base + 2] = route.amount;
    });
  }

  const kernel = def.create(sampleRate);
  kernel.applyParams(block);
  for (const n of spec.notes) {
    const freq = n.freq ?? noteToFreq(n.note ?? '');
    kernel.noteOn(n.time, freq, n.duration, n.velocity ?? 1, n.mono ?? false);
  }

  const wantFrames = Math.round(spec.seconds * sampleRate);
  const paddedFrames = Math.ceil(wantFrames / BLOCK) * BLOCK;
  const out = new Float32Array(paddedFrames);
  for (let f = 0; f < paddedFrames; f += BLOCK) {
    kernel.process(out.subarray(f, f + BLOCK), BLOCK, f);
  }
  return { samples: out.subarray(0, wantFrames), sampleRate };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/render/engine.test.ts` then `npm run typecheck -w @fiddle/audio-lab`
Expected: 6 tests PASS; typecheck exits 0. If the synth2 pitch assertion fails on the octave-region bounds, print `pitch.medianF0` and inspect: the default patch's oscillator tuning decides the octave — adjust the asserted region to the actual default-patch octave for A3 input (it must still be stable across runs), and note the finding in the commit message.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/render
git commit -m "feat(audio-lab): Tier 1 kernel renderer (all five *2 engines, params + matrix)"
```

---

### Task 7: Plot rendering

**Files:**
- Create: `packages/audio-lab/src/report/plots.ts`
- Test: `packages/audio-lab/src/report/plots.test.ts`

**Interfaces:**
- Consumes: `AudioClip`; `EnvelopeAnalysis` from `../analyze/envelope`; `PitchAnalysis` from `../analyze/pitch`; `SpectrogramData` from `../analyze/spectrum`; `pngjs`.
- Produces:
  ```ts
  function waveformPng(clip: AudioClip, opts?: { width?: number; height?: number }): Buffer   // default 1200x300
  function spectrogramPng(spec: SpectrogramData, sampleRate: number, fftSize: number, opts?: { width?: number; height?: number }): Buffer // default 1200x400, log-frequency
  function envelopeSvg(env: EnvelopeAnalysis): string
  function pitchSvg(pitch: PitchAnalysis): string
  ```

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/report/plots.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/report/plots.test.ts`
Expected: FAIL — cannot resolve `./plots`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/report/plots.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/report/plots.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/report/plots.ts packages/audio-lab/src/report/plots.test.ts
git commit -m "feat(audio-lab): plot rendering (waveform/spectrogram PNG, envelope/pitch SVG)"
```

---

### Task 8: Run-directory report writer

**Files:**
- Create: `packages/audio-lab/src/report/report.ts`
- Test: `packages/audio-lab/src/report/report.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  ```ts
  interface RunSummary {
    seconds: number; sampleRate: number;
    peakDb: number | null; rmsDb: number | null;   // null encodes -Infinity (JSON-safe)
    onsets: number[]; attackSeconds: number | null; decaySeconds: number | null;
    medianF0: number | null; f0Range: [number, number] | null;
    meanCentroidHz: number | null;
    spectralPeaks: { hz: number; db: number }[];
    healthFlags: string[];
  }
  interface RunReport {
    summary: RunSummary;
    envelope: EnvelopeAnalysis;      // rmsDb/peakDb -Infinity serialized as null
    pitch: { frames: PitchFrame[]; medianF0: number | null; minF0: number | null; maxF0: number | null };
    spectrum: { binHz: number; averageMagnitudeDb: number[]; peaks: SpectralPeak[]; meanCentroidHz: number | null };
    health: HealthReport;
  }
  function buildReport(clip: AudioClip): RunReport
  function writeRunDir(opts: { dir: string; spec: unknown; clip: AudioClip }): Promise<RunReport>
  // writes: report.json, render.wav, waveform.png, spectrogram.png, envelope.svg, pitch.svg, spec.json
  function defaultRunDir(label: string): string  // .audio-lab/runs/<yyyymmdd-hhmmss>-<label>
  ```

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/report/report.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/report/report.test.ts`
Expected: FAIL — cannot resolve `./report`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/report/report.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/report/report.test.ts`
Expected: 4 tests PASS. (Note: `writeRunDir` analyzes twice — once in `buildReport`, once for plots. That's deliberate simplicity; renders are short. Do NOT "optimize" by caching unless it measurably hurts.)

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/report/report.ts packages/audio-lab/src/report/report.test.ts
git commit -m "feat(audio-lab): run-directory report writer"
```

---

### Task 9: A/B compare

**Files:**
- Create: `packages/audio-lab/src/analyze/compare.ts`
- Test: `packages/audio-lab/src/analyze/compare.test.ts`

**Interfaces:**
- Consumes: `RunReport` from `../report/report`.
- Produces:
  ```ts
  interface MetricDelta { a: number | null; b: number | null; delta: number | null }
  interface CompareResult { metrics: Record<string, MetricDelta>; notes: string[] }
  function compareReports(a: RunReport, b: RunReport): CompareResult
  // metrics keys: peakDb, rmsDb, medianF0, minF0, maxF0, meanCentroidHz,
  //               attackSeconds, decaySeconds, onsetCount
  // notes: human/agent-readable lines for categorical changes (health flags added/removed)
  ```

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/analyze/compare.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compareReports } from './compare';
import { buildReport } from '../report/report';
import type { AudioClip } from '../types';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 0.5): AudioClip {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { samples, sampleRate: SR };
}

describe('compareReports', () => {
  it('reports frequency and level deltas', () => {
    const a = buildReport(sine(220, 0.5, 0.25));
    const b = buildReport(sine(440, 0.5, 0.5));
    const c = compareReports(a, b);
    expect(c.metrics.medianF0.delta).toBeCloseTo(220, -1);
    expect(c.metrics.peakDb.delta).toBeCloseTo(6, 0);
    expect(c.metrics.onsetCount.a).toBe(1);
  });

  it('null-safe when one side is silent', () => {
    const a = buildReport({ samples: new Float32Array(SR / 10), sampleRate: SR });
    const b = buildReport(sine(440, 0.5));
    const c = compareReports(a, b);
    expect(c.metrics.medianF0.a).toBeNull();
    expect(c.metrics.medianF0.delta).toBeNull();
    expect(c.notes.join(' ')).toMatch(/MOSTLY_SILENT/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/compare.test.ts`
Expected: FAIL — cannot resolve `./compare`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/analyze/compare.ts`:

```ts
// Summary-level A/B deltas between two runs. Per-hop diffing is deliberately
// out of scope: the agent reads both reports' arrays directly when it needs
// fine-grained comparison. Renders are not bit-identical (free-running PRNGs),
// so treat sub-dB / sub-Hz deltas as noise.
import type { RunReport } from '../report/report';

export interface MetricDelta { a: number | null; b: number | null; delta: number | null }

export interface CompareResult {
  metrics: Record<string, MetricDelta>;
  notes: string[];
}

export function compareReports(a: RunReport, b: RunReport): CompareResult {
  const pick = (r: RunReport): Record<string, number | null> => ({
    peakDb: r.summary.peakDb,
    rmsDb: r.summary.rmsDb,
    medianF0: r.summary.medianF0,
    minF0: r.summary.f0Range ? r.summary.f0Range[0] : null,
    maxF0: r.summary.f0Range ? r.summary.f0Range[1] : null,
    meanCentroidHz: r.summary.meanCentroidHz,
    attackSeconds: r.summary.attackSeconds,
    decaySeconds: r.summary.decaySeconds,
    onsetCount: r.summary.onsets.length,
  });

  const va = pick(a);
  const vb = pick(b);
  const metrics: Record<string, MetricDelta> = {};
  for (const key of Object.keys(va)) {
    const x = va[key];
    const y = vb[key];
    metrics[key] = { a: x, b: y, delta: x !== null && y !== null ? y - x : null };
  }

  const notes: string[] = [];
  const fa = new Set(a.summary.healthFlags);
  const fb = new Set(b.summary.healthFlags);
  for (const f of fb) if (!fa.has(f)) notes.push(`health flag appeared in B: ${f}`);
  for (const f of fa) if (!fb.has(f)) notes.push(`health flag cleared in B: ${f}`);

  return { metrics, notes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/analyze/compare.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/analyze/compare.ts packages/audio-lab/src/analyze/compare.test.ts
git commit -m "feat(audio-lab): A/B report compare"
```

---

### Task 10: CLI

**Files:**
- Create: `packages/audio-lab/src/cli.ts`
- Create: `packages/audio-lab/src/index.ts`
- Test: `packages/audio-lab/src/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // cli.ts exports (unit-testable without child processes):
  function parseCliArgs(argv: string[]): CliCommand   // throws CliUsageError with usage text
  type CliCommand =
    | { kind: 'render-engine'; spec: EngineRenderSpec; label: string; out?: string }
    | { kind: 'analyze'; file: string; label: string; out?: string }
    | { kind: 'compare'; dirA: string; dirB: string };
  async function runCli(cmd: CliCommand): Promise<{ dir?: string; summaryText: string }>
  // src/index.ts re-exports the public library surface (types, renderEngine,
  // analyzers, buildReport, writeRunDir, compareReports) for future Vitest
  // regression assertions in other packages.
  ```
- CLI grammar (documented in `--help` / usage error):
  ```
  npm run lab -- render-engine <engine> [--set key=value]... [--matrix src:dest:amount]...
      [--notes NOTE:START:DUR[,...]] [--seconds N] [--mono] [--label NAME] [--out DIR] [--sr HZ]
  npm run lab -- analyze <file.wav> [--label NAME] [--out DIR]
  npm run lab -- compare <runDirA> <runDirB>
  ```
  Notes default: `A3:0:0.5`. Seconds default: last note end + 1.0. Label default: engine name / wav basename.

- [ ] **Step 1: Write the failing test**

`packages/audio-lab/src/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCliArgs, runCli } from './cli';
import { buildReport } from './report/report';

describe('parseCliArgs', () => {
  it('parses a full render-engine command', () => {
    const cmd = parseCliArgs([
      'render-engine', 'synth2',
      '--set', 'filter.cutoff=800',
      '--set', 'osc1.wave=2',
      '--matrix', 'lfo1:filter.cutoff:0.8',
      '--notes', 'A3:0:0.5,C4:0.5:0.5',
      '--seconds', '2',
      '--mono',
      '--label', 'porta-test',
    ]);
    if (cmd.kind !== 'render-engine') throw new Error('wrong kind');
    expect(cmd.spec.engine).toBe('synth2');
    expect(cmd.spec.params).toEqual({ 'filter.cutoff': 800, 'osc1.wave': 2 });
    expect(cmd.spec.matrix).toEqual([{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.8 }]);
    expect(cmd.spec.notes).toEqual([
      { time: 0, note: 'A3', duration: 0.5, mono: true },
      { time: 0.5, note: 'C4', duration: 0.5, mono: true },
    ]);
    expect(cmd.spec.seconds).toBe(2);
    expect(cmd.label).toBe('porta-test');
  });

  it('defaults notes, seconds and label', () => {
    const cmd = parseCliArgs(['render-engine', 'kick2']);
    if (cmd.kind !== 'render-engine') throw new Error('wrong kind');
    expect(cmd.spec.notes).toEqual([{ time: 0, note: 'A3', duration: 0.5, mono: false }]);
    expect(cmd.spec.seconds).toBeCloseTo(1.5, 5); // last note end (0.5) + 1
    expect(cmd.label).toBe('kick2');
  });

  it('throws usage on unknown commands and bad flags', () => {
    expect(() => parseCliArgs([])).toThrow(/usage/i);
    expect(() => parseCliArgs(['frobnicate'])).toThrow(/usage/i);
    expect(() => parseCliArgs(['render-engine', 'synth2', '--set', 'noequals'])).toThrow(/key=value/);
    expect(() => parseCliArgs(['compare', 'onlyone'])).toThrow(/usage/i);
  });
});

describe('runCli', () => {
  it('render-engine writes a run dir and returns a summary', async () => {
    const base = await mkdtemp(join(tmpdir(), 'audio-lab-cli-'));
    try {
      const cmd = parseCliArgs(['render-engine', 'kick2', '--out', join(base, 'run'), '--seconds', '1']);
      const res = await runCli(cmd);
      expect(res.dir).toBe(join(base, 'run'));
      expect(await readdir(join(base, 'run'))).toContain('report.json');
      expect(res.summaryText).toContain('peakDb');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('compare reads two run dirs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'audio-lab-cmp-'));
    try {
      const mk = async (name: string, freq: number) => {
        const samples = new Float32Array(24000);
        for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / 48000);
        const dir = join(base, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'report.json'), JSON.stringify(buildReport({ samples, sampleRate: 48000 })));
        return dir;
      };
      const res = await runCli({ kind: 'compare', dirA: await mk('a', 220), dirB: await mk('b', 440) });
      expect(res.summaryText).toContain('medianF0');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/audio-lab -- src/cli.test.ts`
Expected: FAIL — cannot resolve `./cli`.

- [ ] **Step 3: Implement**

`packages/audio-lab/src/index.ts`:

```ts
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
export type { RunReport, RunSummary } from './report/report';
export { encodeWav, decodeWav } from './report/wav';
```

`packages/audio-lab/src/cli.ts`:

```ts
// CLI entry. Parsing is a pure exported function; runCli does the IO. The
// summary block always goes to stdout so the invoking agent sees the numbers
// without opening report.json.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineRenderSpec, NoteEvent, MatrixRoute, EngineId } from './render/engine';
import { renderEngine, ENGINE_IDS } from './render/engine';
import { compareReports } from './analyze/compare';
import { writeRunDir, defaultRunDir, type RunReport } from './report/report';
import { decodeWav } from './report/wav';

const USAGE = `audio-lab usage:
  npm run lab -- render-engine <engine> [--set key=value]... [--matrix src:dest:amount]...
      [--notes NOTE:START:DUR[,...]] [--seconds N] [--mono] [--label NAME] [--out DIR] [--sr HZ]
  npm run lab -- analyze <file.wav> [--label NAME] [--out DIR]
  npm run lab -- compare <runDirA> <runDirB>

  engines: ${ENGINE_IDS.join(', ')}
  notes syntax: NOTE:START_SECONDS:DURATION_SECONDS, comma-separated (default A3:0:0.5)
  runs land in .audio-lab/runs/<timestamp>-<label>/ unless --out is given`;

export class CliUsageError extends Error {}

export type CliCommand =
  | { kind: 'render-engine'; spec: EngineRenderSpec; label: string; out?: string }
  | { kind: 'analyze'; file: string; label: string; out?: string }
  | { kind: 'compare'; dirA: string; dirB: string };

export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === 'render-engine') return parseRenderEngine(rest);
  if (command === 'analyze') return parseAnalyze(rest);
  if (command === 'compare') {
    if (rest.length !== 2) throw new CliUsageError(USAGE);
    return { kind: 'compare', dirA: rest[0], dirB: rest[1] };
  }
  throw new CliUsageError(USAGE);
}

interface FlagBag { positional: string[]; single: Map<string, string>; multi: Map<string, string[]>; bool: Set<string> }

const MULTI_FLAGS = new Set(['--set', '--matrix']);
const BOOL_FLAGS = new Set(['--mono']);

function collectFlags(args: string[]): FlagBag {
  const bag: FlagBag = { positional: [], single: new Map(), multi: new Map(), bool: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      bag.positional.push(a);
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      bag.bool.add(a);
      continue;
    }
    const v = args[++i];
    if (v === undefined) throw new CliUsageError(`flag ${a} needs a value\n${USAGE}`);
    if (MULTI_FLAGS.has(a)) {
      const arr = bag.multi.get(a) ?? [];
      arr.push(v);
      bag.multi.set(a, arr);
    } else {
      bag.single.set(a, v);
    }
  }
  return bag;
}

function parseNotes(text: string, mono: boolean): NoteEvent[] {
  return text.split(',').map((part) => {
    const bits = part.trim().split(':');
    if (bits.length !== 3) {
      throw new CliUsageError(`bad note '${part}' (want NOTE:START:DUR)\n${USAGE}`);
    }
    return { time: Number(bits[1]), note: bits[0], duration: Number(bits[2]), mono };
  });
}

function parseRenderEngine(args: string[]): CliCommand {
  const bag = collectFlags(args);
  const engine = bag.positional[0] as EngineId | undefined;
  if (!engine) throw new CliUsageError(USAGE);

  const mono = bag.bool.has('--mono');
  const notes = parseNotes(bag.single.get('--notes') ?? 'A3:0:0.5', mono);

  const params: Record<string, number> = {};
  for (const kv of bag.multi.get('--set') ?? []) {
    const eq = kv.indexOf('=');
    if (eq < 1) throw new CliUsageError(`--set wants key=value, got '${kv}'`);
    params[kv.slice(0, eq)] = Number(kv.slice(eq + 1));
  }

  const matrix: MatrixRoute[] = (bag.multi.get('--matrix') ?? []).map((m) => {
    const bits = m.split(':');
    if (bits.length !== 3) throw new CliUsageError(`--matrix wants src:dest:amount, got '${m}'`);
    return { source: bits[0], dest: bits[1], amount: Number(bits[2]) };
  });

  const lastEnd = notes.reduce((mx, n) => Math.max(mx, n.time + n.duration), 0);
  const seconds = bag.single.has('--seconds') ? Number(bag.single.get('--seconds')) : lastEnd + 1;

  const spec: EngineRenderSpec = { engine, notes, seconds };
  if (Object.keys(params).length) spec.params = params;
  if (matrix.length) spec.matrix = matrix;
  if (bag.single.has('--sr')) spec.sampleRate = Number(bag.single.get('--sr'));

  return {
    kind: 'render-engine',
    spec,
    label: bag.single.get('--label') ?? engine,
    out: bag.single.get('--out'),
  };
}

function parseAnalyze(args: string[]): CliCommand {
  const bag = collectFlags(args);
  const file = bag.positional[0];
  if (!file) throw new CliUsageError(USAGE);
  const base = file.split('/').pop()!.replace(/\.wav$/i, '');
  return { kind: 'analyze', file, label: bag.single.get('--label') ?? base, out: bag.single.get('--out') };
}

function summaryText(report: RunReport): string {
  return JSON.stringify(report.summary, null, 2);
}

export async function runCli(cmd: CliCommand): Promise<{ dir?: string; summaryText: string }> {
  if (cmd.kind === 'render-engine') {
    const clip = renderEngine(cmd.spec);
    const dir = cmd.out ?? defaultRunDir(cmd.label);
    const report = await writeRunDir({ dir, spec: cmd.spec, clip });
    return { dir, summaryText: summaryText(report) };
  }
  if (cmd.kind === 'analyze') {
    const clip = decodeWav(new Uint8Array(await readFile(cmd.file)));
    const dir = cmd.out ?? defaultRunDir(cmd.label);
    const report = await writeRunDir({ dir, spec: { source: cmd.file }, clip });
    return { dir, summaryText: summaryText(report) };
  }
  const a = JSON.parse(await readFile(join(cmd.dirA, 'report.json'), 'utf8')) as RunReport;
  const b = JSON.parse(await readFile(join(cmd.dirB, 'report.json'), 'utf8')) as RunReport;
  return { summaryText: JSON.stringify(compareReports(a, b), null, 2) };
}

// Entry point when executed directly (tsx src/cli.ts ...), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  (async () => {
    try {
      const cmd = parseCliArgs(process.argv.slice(2));
      const res = await runCli(cmd);
      if (res.dir) console.log(`run dir: ${res.dir}`);
      console.log(res.summaryText);
    } catch (err) {
      console.error(err instanceof CliUsageError ? err.message : err);
      process.exitCode = 1;
    }
  })();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/audio-lab -- src/cli.test.ts` then `npm run typecheck -w @fiddle/audio-lab`
Expected: 6 tests PASS; typecheck exits 0.

- [ ] **Step 5: Smoke the real entry point**

Run from repo root:
```bash
npm run lab -- render-engine synth2 --notes "A3:0:0.5,A4:0.6:0.5" --label smoke
```
Expected: prints `run dir: .audio-lab/runs/<timestamp>-smoke` and a JSON summary with non-null `peakDb`, `medianF0`, empty `healthFlags` (or explainable flags); the directory contains all 7 files. Then `git status` must show NO new tracked files from the run (`.audio-lab/` ignored).

- [ ] **Step 6: Commit**

```bash
git add packages/audio-lab/src/cli.ts packages/audio-lab/src/cli.test.ts packages/audio-lab/src/index.ts
git commit -m "feat(audio-lab): CLI (render-engine / analyze / compare) + library index"
```

---

### Task 11: Agent skill

**Files:**
- Create: `.claude/skills/audio-lab/SKILL.md`

**Interfaces:**
- Consumes: the CLI grammar from Task 10 (commands must match exactly).
- Produces: a project skill named `audio-lab` that future agent sessions load before verifying any audible-behavior change.

- [ ] **Step 1: Write the skill**

`.claude/skills/audio-lab/SKILL.md`:

```markdown
---
name: audio-lab
description: Render Fiddle Synth engines offline and analyze the sound (pitch track, envelope, spectrogram, health) — use before claiming any audible-behavior change works, and to diagnose "why does it sound wrong" reports.
---

# Audio Lab — offline sound verification

Renders the real `*2` kernels (synth2, kick2, hat2, snare2, clap2) in Node and
produces metrics you can read. **It complements, never replaces, the mandatory
browser verification pass** — the browser proves the app wiring; the lab
proves the sound.

## Commands (repo root)

```bash
# Render an engine. Params use the app's wire keys (same as SYNTH2_DESCRIPTORS etc).
npm run lab -- render-engine synth2 --set filter.cutoff=800 \
  --notes "A3:0:0.5,C4:0.6:0.5" --mono --label my-check

# Mod-matrix routes (synth2 only):
npm run lab -- render-engine synth2 --matrix lfo1:filter.cutoff:0.8 --notes "A2:0:1.5"

# Metrics for any WAV; A/B two runs:
npm run lab -- analyze path/to/file.wav
npm run lab -- compare .audio-lab/runs/<A> .audio-lab/runs/<B>
```

Notes syntax `NOTE:START:DUR` (seconds). `--mono` = monophonic voice
allocation — REQUIRED for portamento/glide checks. Unknown `--set` keys fail
with the full valid-key list — that error IS the param reference.

## Reading a run

Each run directory (printed to stdout, under `.audio-lab/runs/`) contains:

- `report.json` — read `summary` first: `peakDb`, `medianF0`, `f0Range`,
  `onsets`, `attackSeconds`, `decaySeconds`, `meanCentroidHz`,
  `spectralPeaks`, `healthFlags`. Full per-hop arrays follow.
- `waveform.png`, `spectrogram.png` — open with the Read tool (they render as
  images). Spectrogram is log-frequency, bright = loud.
- `pitch.svg`, `envelope.svg` — text SVG; the polyline point coordinates are
  the data if you need to read them precisely.
- `render.wav` — send to the user (SendUserFile) whenever a judgment call is
  contested or aesthetic ("does this sound *good*") rather than measurable.

## Interpretation heuristics

- **Check `healthFlags` first.** `NON_FINITE` or `MOSTLY_SILENT` = the render
  is broken; no other metric means anything.
- **Portamento/glide:** render two notes with `--mono`. In `report.json`
  pitch frames, f0 should move smoothly from note 1 to note 2 after the second
  onset. Quantify with `pitchSettleTime` (exported from `@fiddle/audio-lab`)
  or compare `f0Range` across knob settings. No portamento = f0 jumps within
  1-2 frames (~10-20ms); portamento = settle time scales with the knob.
- **Filter cutoff:** `meanCentroidHz` drops as cutoff drops. LFO→cutoff
  wobble shows as periodic centroid movement and visible bands in the
  spectrogram.
- **Envelopes/decay knobs:** `attackSeconds` / `decaySeconds` in the summary;
  the envelope points give the full curve.
- **Tuning:** `medianF0` within ~1Hz for a steady tone. The pitch tracker
  reports null f0 for noisy/unpitched content (hats, claps) — that is
  expected, not a failure; judge those by envelope + spectrum instead.
- **Timing:** `onsets` should match the scheduled note starts within ~10ms.

## Tolerances (never assert exact values)

Kernel noise/S&H PRNGs are seeded per construction by design
(free-running randomness is a feature) — two renders of the same spec are NOT
bit-identical. Compare metrics with tolerances: dB ±1, f0 ±1Hz for steady
tones, times ±10ms. Noise-heavy engines vary more; rely on RMS envelope and
band energy, not sample values.

## Workflow for a DSP change

1. Render a baseline BEFORE the change (`--label before-<feature>`).
2. Make the change; render again (`--label after-<feature>`).
3. `compare` the two run dirs; read the deltas against what the change should do.
4. Also open the after-run's spectrogram/pitch plots — deltas summarize, plots
   catch the unexpected.
5. Report the numbers in your summary to the user, and attach `render.wav`
   when the user should hear it.

## Limits

- Tier 1 covers the five `*2` kernels only; v1 engines and the full project
  mix need the Tier 2 browser harness (Phase 2 — not built yet).
- Renders are mono.
- Long renders are cheap but not free (~a few seconds of CPU per minute of
  audio); keep checks in the 1-5s range.
```

- [ ] **Step 2: Verify the referenced commands exist**

Run: `npm run lab -- render-engine synth2 --matrix lfo1:filter.cutoff:0.8 --notes "A2:0:1.5" --label skill-doc-check`
Expected: exits 0, prints a run dir + summary (proves the skill's copy-paste examples are real). Delete nothing — `.audio-lab/` is ignored.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/audio-lab/SKILL.md
git commit -m "docs(audio-lab): agent skill — usage + interpretation guide"
```

---

### Task 12: Full gate + end-to-end verification

**Files:**
- None created; verification only (fix-forward if anything fails).

- [ ] **Step 1: Run the merge gate**

Run from repo root: `npm run typecheck && npm test && npm run build`
Expected: all green, including the new `@fiddle/audio-lab` workspace in typecheck and test fan-out; client/server builds unaffected. If `npm test` runs audio-lab twice or not at all, check `--workspaces --if-present` picked up the new package (`npm test --workspaces --if-present` lists it).

- [ ] **Step 2: End-to-end agent verification (the tool's own acceptance test)**

This validates the actual deliverable: that an agent can *conclude something about sound* from the outputs.

```bash
npm run lab -- render-engine synth2 --set filter.cutoff=8000 --notes "A2:0:1.2" --label bright
npm run lab -- render-engine synth2 --set filter.cutoff=300 --notes "A2:0:1.2" --label dark
npm run lab -- compare .audio-lab/runs/<bright-dir> .audio-lab/runs/<dark-dir>
```

Expected observations (report them):
- `meanCentroidHz` delta is strongly negative (dark < bright) — the tool detects a filter move.
- Both runs: `healthFlags` empty, one onset near 0, non-null `medianF0`, both `medianF0` values within a few Hz of each other (cutoff must not change pitch).
- Open both `spectrogram.png` files with the Read tool and confirm the dark render's energy visibly concentrates at the bottom (low frequencies).
- Open `render.wav` metadata is not needed — instead SendUserFile one of the WAVs with a one-line caption so the user can hear a Tier 1 render once.

- [ ] **Step 3: Verify no stray repo pollution**

Run: `git status`
Expected: working tree clean apart from the pre-existing untracked scratch files (`studio-focused.md`, `*.png` at repo root — NEVER stage those); no `.audio-lab/` entries visible.

- [ ] **Step 4: Report**

Summarize to the user: gate results, the bright/dark comparison numbers, what the spectrograms showed, and that the branch is ready for their review (do NOT merge — user merges after their own check, per repo rules).
```
