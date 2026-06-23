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

  it('renders a train of transients spaced by `spread` (the claps)', () => {
    const spread = 0.04, body = 0.004;
    const out = renderHit({ bursts: 4, spread, body, room: 0.05, mix: 0, tone: 1000 }, 0.25);
    const win = Math.floor(SR * 0.004); // 4ms window
    const at = (sec: number) => rms(out, Math.floor(sec * SR), Math.floor(sec * SR) + win);
    // Energy peaks AT each clap onset and dips BETWEEN consecutive claps.
    for (let j = 0; j < 3; j++) {
      const onset = at(j * spread);
      const between = at((j + 0.5) * spread);
      expect(onset, `clap ${j} onset vs gap`).toBeGreaterThan(between);
    }
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
});
