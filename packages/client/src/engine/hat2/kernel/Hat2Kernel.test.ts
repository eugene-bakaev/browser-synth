import { describe, it, expect } from 'vitest';
import { Hat2Kernel } from './Hat2Kernel';
import { PARAM_INDEX, PARAM_COUNT, BLOCK_LENGTH, defaultParamBlock } from './params';
import { HAT2_DESCRIPTORS } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

function renderBlocks(kernel: Hat2Kernel, startFrame: number, blocks: number): Float32Array {
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
  const kernel = new Hat2Kernel(SR);
  kernel.applyParams(withParam(overrides));
  kernel.noteOn(0, 0, 0, 1);
  return renderBlocks(kernel, 0, Math.ceil((SR * seconds) / BLOCK));
}

describe('hat2 param block layout', () => {
  it('one index per descriptor, in table order', () => {
    expect(PARAM_COUNT).toBe(HAT2_DESCRIPTORS.length);
    expect(BLOCK_LENGTH).toBe(HAT2_DESCRIPTORS.length);
    HAT2_DESCRIPTORS.forEach((d, i) => expect(PARAM_INDEX[d.key]).toBe(i));
    const block = defaultParamBlock();
    HAT2_DESCRIPTORS.forEach((d, i) => expect(block[i]).toBeCloseTo(d.default, 6));
  });
});

describe('Hat2Kernel', () => {
  it('renders exact silence with no trigger', () => {
    const out = renderBlocks(new Hat2Kernel(SR), 0, 8);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('triggers at the exact frame offset inside a block', () => {
    const kernel = new Hat2Kernel(SR);
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
    const early = rms(out, 0, SR * 0.02); // first 20ms
    const late = rms(out, SR * 0.3, SR * 0.32); // ~300ms in — past the 80ms decay
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
      const kernel = new Hat2Kernel(SR);
      kernel.noteOn(0, 0, 0, vel);
      const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK));
      let p = 0;
      for (let i = 0; i < out.length; i++) p = Math.max(p, Math.abs(out[i]));
      return p;
    }
    expect(peak(1)).toBeGreaterThan(peak(0.25));
  });

  it('longer decay = more total energy (open vs closed hat)', () => {
    function energy(decay: number): number {
      const out = renderHit({ decay }, 1.0);
      let e = 0;
      for (let i = 0; i < out.length; i++) e += out[i] * out[i];
      return e;
    }
    expect(energy(0.5)).toBeGreaterThan(energy(0.05) * 3);
  });

  it('metallic crossfades cluster vs noise (the knob changes the sound)', () => {
    const m1 = renderHit({ metallic: 1 }, 0.1); // pure metal cluster
    const m0 = renderHit({ metallic: 0 }, 0.1); // pure noise
    const a = rms(m1, 0, Math.floor(SR * 0.05));
    const b = rms(m0, 0, Math.floor(SR * 0.05));
    expect(a).toBeGreaterThan(0.01); // metal path audible
    expect(b).toBeGreaterThan(0.01); // noise path audible
    // uncorrelated sources ⇒ their difference is at least as large as either
    expect(rmsDiff(m1, m0, 0, Math.floor(SR * 0.05))).toBeGreaterThan(a * 0.5);
  });

  it('ring changes the cluster timbre (the knob is wired)', () => {
    const r0 = renderHit({ metallic: 1, ring: 0 }, 0.1);
    const r1 = renderHit({ metallic: 1, ring: 1 }, 0.1);
    // ring is wired iff the two render differently; a dead knob ⇒ identical ⇒ 0
    expect(rmsDiff(r1, r0, 0, Math.floor(SR * 0.05))).toBeGreaterThan(1e-3);
  });
});

describe('ring level-match (F4)', () => {
  it('ring=1 peaks within ~1.5dB of ring=0 (timbre knob, not a volume ride)', () => {
    const peak = (buf: Float32Array) => {
      let p = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; }
      return p;
    };
    const p0 = peak(renderHit({ ring: 0, decay: 0.3 }, 0.8));
    const p1 = peak(renderHit({ ring: 1, decay: 0.3 }, 0.8));
    const deltaDb = 20 * Math.log10(p1 / p0);
    // measured pre-fix: +7.28dB
    expect(Math.abs(deltaDb)).toBeLessThan(1.5);
  });
});
