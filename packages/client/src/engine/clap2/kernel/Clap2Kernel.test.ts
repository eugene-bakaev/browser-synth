import { describe, it, expect } from 'vitest';
import { Clap2Kernel } from './Clap2Kernel';
import { PARAM_INDEX, PARAM_COUNT, BLOCK_LENGTH, defaultParamBlock } from './params';
import { CLAP2_DESCRIPTORS } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

function renderBlocks(kernel: Clap2Kernel, startFrame: number, blocks: number): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  const buf = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    kernel.process(buf, BLOCK, startFrame + b * BLOCK);
    out.set(buf, b * BLOCK);
  }
  return out;
}

function rms(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function rmsDiff(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum / Math.max(1, to - from));
}

function withParam(overrides: Record<string, number>): Float32Array {
  const block = defaultParamBlock();
  for (const [k, v] of Object.entries(overrides)) block[PARAM_INDEX[k]] = v;
  return block;
}

function renderHit(overrides: Record<string, number>, seconds: number): Float32Array {
  const kernel = new Clap2Kernel(SR);
  kernel.applyParams(withParam(overrides));
  kernel.noteOn(0, 0, 0, 1);
  return renderBlocks(kernel, 0, Math.ceil((SR * seconds) / BLOCK));
}

function slapPeaks(buf: Float32Array, onsetsSec: number[], winSec: number): number[] {
  return onsetsSec.map((sec) => {
    const from = Math.floor(sec * SR), to = from + Math.floor(winSec * SR);
    let p = 0;
    for (let i = from; i < Math.min(to, buf.length); i++) p = Math.max(p, Math.abs(buf[i]));
    return p;
  });
}

// Crude spectral-centroid proxy: mean |first difference| / mean |signal| rises with
// brightness (more HF ⇒ larger sample-to-sample change relative to amplitude).
function brightness(buf: Float32Array, from: number, to: number): number {
  let diff = 0, mag = 0;
  for (let i = from + 1; i < to; i++) { diff += Math.abs(buf[i] - buf[i - 1]); mag += Math.abs(buf[i]); }
  return diff / Math.max(1e-9, mag);
}

describe('clap2 param block layout', () => {
  it('one index per descriptor, in table order', () => {
    expect(PARAM_COUNT).toBe(CLAP2_DESCRIPTORS.length);
    expect(BLOCK_LENGTH).toBe(CLAP2_DESCRIPTORS.length);
    CLAP2_DESCRIPTORS.forEach((d, i) => expect(PARAM_INDEX[d.key]).toBe(i));
    const block = defaultParamBlock();
    CLAP2_DESCRIPTORS.forEach((d, i) => expect(block[i]).toBeCloseTo(d.default, 6));
  });
});

describe('Clap2Kernel', () => {
  function renderHitSeeded(seed: number, seconds: number): Float32Array {
    const kernel = new Clap2Kernel(SR, seed);
    kernel.applyParams(defaultParamBlock());
    kernel.noteOn(0, 0, 0, 1);
    return renderBlocks(kernel, 0, Math.ceil((SR * seconds) / BLOCK));
  }

  it('is reproducible for a given seed', () => {
    const a = renderHitSeeded(12345, 0.2);
    const b = renderHitSeeded(12345, 0.2);
    expect(rmsDiff(a, b, 0, a.length)).toBe(0); // identical stream
  });

  it('different seeds produce different renders (per-session entropy is real)', () => {
    const a = renderHitSeeded(111, 0.2);
    const b = renderHitSeeded(222, 0.2);
    expect(rmsDiff(a, b, 0, a.length)).toBeGreaterThan(1e-3);
  });

  it('the default seed is stable (audit/render reproducibility)', () => {
    const a = renderHit({}, 0.2);
    const b = renderHit({}, 0.2);
    expect(rmsDiff(a, b, 0, a.length)).toBe(0);
  });

  it('renders exact silence with no trigger', () => {
    const out = renderBlocks(new Clap2Kernel(SR), 0, 8);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('triggers at the exact frame offset inside a block', () => {
    const kernel = new Clap2Kernel(SR);
    kernel.noteOn(64 / SR, 0, 0, 1); // due at absolute frame 64
    const buf = new Float32Array(BLOCK);
    kernel.process(buf, BLOCK, 0);
    for (let i = 0; i < 64; i++) expect(buf[i]).toBe(0); // silent before the hit
    let energyAfter = 0;
    for (let i = 64; i < BLOCK; i++) energyAfter += Math.abs(buf[i]);
    expect(energyAfter).toBeGreaterThan(0); // audible after
  });

  it('produces a decaying envelope (loud at onset, silent a beat later)', () => {
    const out = renderHit({}, 1.0);
    const early = rms(out, 0, Math.floor(SR * 0.02)); // first 20ms
    const late = rms(out, Math.floor(SR * 0.6), Math.floor(SR * 0.62)); // past the 250ms room tail
    expect(early).toBeGreaterThan(0.01);
    expect(late).toBeLessThan(early * 0.1);
  });

  it('stays finite and within range for a full hit', () => {
    const out = renderHit({}, 1.0);
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Math.abs(out[i])).toBeLessThan(4);
    }
  });

  it('velocity scales output level', () => {
    function peak(vel: number): number {
      const kernel = new Clap2Kernel(SR);
      kernel.noteOn(0, 0, 0, vel);
      const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK));
      let p = 0;
      for (let i = 0; i < out.length; i++) p = Math.max(p, Math.abs(out[i]));
      return p;
    }
    expect(peak(1)).toBeGreaterThan(peak(0.25));
  });

  it('applyParams ignores non-finite entries (keeps the prior value)', () => {
    const kernel = new Clap2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['level']] = NaN;
    kernel.applyParams(block); // must not poison the level → output stays finite
    kernel.noteOn(0, 0, 0, 1);
    const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.1) / BLOCK));
    let energy = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      energy += Math.abs(out[i]);
    }
    expect(energy).toBeGreaterThan(0);
  });

  it('renders multiple distinct slaps (not exactly even-spaced)', () => {
    const out = renderHit({ bursts: 4, spread: 0.02, body: 0.004, room: 0.05, mix: 0, tone: 1000 }, 0.25);
    const win = Math.floor(SR * 0.001);
    const at = (sec: number) => rms(out, Math.floor(sec * SR), Math.floor(sec * SR) + win);
    // First slap at t=0 is loud; there is a later, separated slap within the burst
    // window (past 8ms, before 100ms) whose local energy exceeds its neighbours.
    const early = at(0);
    let laterPeak = 0;
    for (let s = 6; s <= 60; s++) laterPeak = Math.max(laterPeak, at(s * 0.0015));
    expect(early).toBeGreaterThan(0.005);
    expect(laterPeak).toBeGreaterThan(0.002);
  });

  it('slap gaps widen across the train (non-uniform, not an even j*spread comb)', () => {
    // Loose spread + very short body so each slap is a sharp, separable spike; mix:0.
    // The old even train spaced slaps by a CONSTANT j*spread; the new pattern widens
    // the gaps, so the detected inter-slap intervals must be increasing.
    const out = renderHit({ mix: 0, bursts: 4, spread: 0.02, body: 0.0015, room: 0.05, tone: 1200 }, 0.3);
    // 2ms envelope-proxy windows: wide enough to average out the bandpassed-noise
    // carrier's own ring (period ~1/tone ≈ 0.8ms at tone:1200) so the detector tracks
    // the per-slap AD envelope shape, not carrier ripple (a 0.5ms window over-resolves
    // spurious sub-onset local maxima from the filter ring — tuned against real render
    // output; see Task 2 report).
    const step = 0.002, win = Math.floor(SR * step);
    const N = Math.floor(0.16 / step);
    const env: number[] = [];
    for (let k = 0; k < N; k++) { const a = Math.floor(k * step * SR); env.push(rms(out, a, a + win)); }
    // Detect slap onsets: local maxima standing clearly above their pre-neighbourhood.
    const peaks: number[] = [];
    for (let k = 2; k < env.length - 2; k++) {
      if (env[k] > env[k - 2] * 1.4 && env[k] >= env[k + 1] && env[k] >= env[k - 1] && env[k] > 0.006) {
        if (peaks.length === 0 || k - peaks[peaks.length - 1] > 5) peaks.push(k); // ≥10ms apart
      }
    }
    expect(peaks.length).toBeGreaterThanOrEqual(3); // ≥3 distinct slaps resolved
    const gaps = peaks.slice(1).map((p, i) => p - peaks[i]);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]); // gaps widen (old comb: equal)
  });

  it('slap amplitude decreases across the train', () => {
    const kernel = new Clap2Kernel(SR, 999);
    kernel.applyParams(withParam({ mix: 0, bursts: 4, spread: 0.02 }));
    kernel.noteOn(0, 0, 0, 1);
    const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK));
    // Compare the first slap window's peak to the last slap window's peak.
    const firstPeak = slapPeaks(out, [0.0005], 0.004)[0];
    const laterPeak = slapPeaks(out, [0.05], 0.02)[0]; // well after the early slaps
    expect(firstPeak).toBeGreaterThan(laterPeak);
  });

  it('hit-to-hit variation: two triggers on one kernel differ (scatter free-runs)', () => {
    const kernel = new Clap2Kernel(SR, 7);
    kernel.applyParams(withParam({ mix: 0 }));
    kernel.noteOn(0, 0, 0, 1);
    const hit1 = renderBlocks(kernel, 0, Math.ceil((SR * 0.15) / BLOCK));
    kernel.noteOn(0, 0, 0, 1); // retrigger — scatter must NOT reset
    const hit2 = renderBlocks(kernel, Math.ceil((SR * 0.15) / BLOCK) * BLOCK, Math.ceil((SR * 0.15) / BLOCK));
    expect(rmsDiff(hit1, hit2, 0, hit1.length)).toBeGreaterThan(1e-3);
  });

  it('scatter pattern free-runs across triggers (a re-seed would make hits identical)', () => {
    // The `hit-to-hit variation` test above still passes even if the slap PATTERN were
    // reset on every trigger, because the independent noise() stream keeps diverging.
    // This locks the pattern itself: read the drawn per-slap onset offsets + amplitudes
    // (white-box, like HatEngine/SnareEngine tests) after two consecutive triggers on
    // one kernel. scatterRng free-runs, so the jittered pattern must differ hit-to-hit.
    // A regression that re-seeded scatterRng inside trigger() would draw the identical
    // pattern both times and fail here.
    type Pattern = { slapOffset: Float32Array; slapAmp: Float32Array; slapCount: number };
    const snap = (k: Clap2Kernel) => {
      const p = k as unknown as Pattern;
      return {
        off: Array.from(p.slapOffset.subarray(0, p.slapCount)),
        amp: Array.from(p.slapAmp.subarray(0, p.slapCount)),
      };
    };

    const kernel = new Clap2Kernel(SR, 7);
    kernel.applyParams(withParam({ mix: 0, bursts: 5, spread: 0.03 }));
    const buf = new Float32Array(BLOCK);

    kernel.noteOn(0, 0, 0, 1);
    kernel.process(buf, BLOCK, 0); // fires trigger() → draws slap pattern #1
    const p1 = snap(kernel);

    kernel.noteOn(0, 0, 0, 1);
    kernel.process(buf, BLOCK, BLOCK); // fires trigger() again → pattern #2 (scatter free-runs)
    const p2 = snap(kernel);

    expect(p1.off.length).toBe(5); // same bursts ⇒ same-length patterns to compare
    expect(p2.off.length).toBe(5);
    expect(p2.off).not.toEqual(p1.off); // jittered gaps advanced ⇒ onset offsets differ
    expect(p2.amp).not.toEqual(p1.amp); // jittered amplitudes advanced ⇒ amps differ
  });

  it('same seed reproduces the scattered pattern', () => {
    const render = (seed: number) => {
      const k = new Clap2Kernel(SR, seed);
      k.applyParams(withParam({ mix: 0 }));
      k.noteOn(0, 0, 0, 1);
      return renderBlocks(k, 0, Math.ceil((SR * 0.15) / BLOCK));
    };
    expect(rmsDiff(render(42), render(42), 0, render(42).length)).toBe(0);
  });

  it('more bursts ⇒ more energy in the burst window', () => {
    const base = { spread: 0.03, body: 0.004, room: 0.05, mix: 0 };
    const burstEnergy = (bursts: number) => {
      const out = renderHit({ ...base, bursts }, 0.25);
      let s = 0;
      const end = Math.floor(0.2 * SR);
      for (let i = 0; i < end; i++) s += out[i] * out[i];
      return s;
    };
    expect(burstEnergy(5)).toBeGreaterThan(burstEnergy(2));
  });

  it('longer room ⇒ more total tail energy', () => {
    const tailEnergy = (room: number) => {
      const out = renderHit({ room, mix: 1, bursts: 2 }, 1.2);
      let s = 0;
      for (let i = 0; i < out.length; i++) s += out[i] * out[i];
      return s;
    };
    expect(tailEnergy(0.8)).toBeGreaterThan(tailEnergy(0.05) * 2);
  });

  it('mix changes the balance (the knob is wired)', () => {
    const m0 = renderHit({ mix: 0 }, 0.2);
    const m1 = renderHit({ mix: 1 }, 0.2);
    expect(rmsDiff(m1, m0, 0, Math.floor(SR * 0.2))).toBeGreaterThan(1e-3);
  });

  it('tone shifts the band (the knob is wired)', () => {
    const lo = renderHit({ tone: 600 }, 0.1);
    const hi = renderHit({ tone: 2800 }, 0.1);
    expect(rmsDiff(hi, lo, 0, Math.floor(SR * 0.05))).toBeGreaterThan(1e-3);
  });

  it('the attack is brighter than the body (HF injection on onset)', () => {
    const out = renderHit({ mix: 0, tone: 1000, body: 0.01 }, 0.1);
    const attackBright = brightness(out, 0, Math.floor(SR * 0.002));      // first 2ms
    const bodyBright = brightness(out, Math.floor(SR * 0.02), Math.floor(SR * 0.04)); // 20–40ms
    expect(attackBright).toBeGreaterThan(bodyBright);
  });

  it('tone still shifts the band (knob remains wired after broadening)', () => {
    const lo = renderHit({ tone: 600 }, 0.1);
    const hi = renderHit({ tone: 2800 }, 0.1);
    expect(rmsDiff(hi, lo, 0, Math.floor(SR * 0.05))).toBeGreaterThan(1e-3);
  });

  it('stays finite and bounded with the HF path added', () => {
    const out = renderHit({ tone: 2800, bursts: 5, mix: 0.5 }, 0.4);
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Math.abs(out[i])).toBeLessThan(4);
    }
  });

  it('mix=0 has (almost) no room tail — pure slaps', () => {
    // With mix=0 the burst train ends by ~lastOnset+body; the tail region must be
    // near-silent (no 0.2-floor room bleed).
    const out = renderHit({ mix: 0, bursts: 3, spread: 0.02, body: 0.006, room: 0.4 }, 0.6);
    const tail = rms(out, Math.floor(SR * 0.3), Math.floor(SR * 0.5)); // 300–500ms
    expect(tail).toBeLessThan(1e-4);
  });

  it('mix still moves energy into the tail (knob remains wired)', () => {
    const tailRms = (mix: number) => {
      const out = renderHit({ mix, bursts: 2, room: 0.4 }, 0.6);
      return rms(out, Math.floor(SR * 0.2), Math.floor(SR * 0.4));
    };
    expect(tailRms(0.9)).toBeGreaterThan(tailRms(0.1) * 2);
  });
});
