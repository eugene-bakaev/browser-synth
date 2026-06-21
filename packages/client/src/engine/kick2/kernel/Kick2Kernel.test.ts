import { describe, it, expect } from 'vitest';
import { Kick2Kernel } from './Kick2Kernel';
import { PARAM_INDEX, PARAM_COUNT, BLOCK_LENGTH, defaultParamBlock } from './params';
import { KICK2_DESCRIPTORS } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

function renderBlocks(kernel: Kick2Kernel, startFrame: number, blocks: number): Float32Array {
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

describe('kick2 param block layout', () => {
  it('one index per descriptor, in table order', () => {
    expect(PARAM_COUNT).toBe(KICK2_DESCRIPTORS.length);
    expect(BLOCK_LENGTH).toBe(KICK2_DESCRIPTORS.length);
    KICK2_DESCRIPTORS.forEach((d, i) => expect(PARAM_INDEX[d.key]).toBe(i));
    const block = defaultParamBlock();
    KICK2_DESCRIPTORS.forEach((d, i) => expect(block[i]).toBeCloseTo(d.default, 6));
  });
});

describe('Kick2Kernel', () => {
  it('renders exact silence with no trigger', () => {
    const out = renderBlocks(new Kick2Kernel(SR), 0, 8);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('triggers at the exact frame offset inside a block', () => {
    const kernel = new Kick2Kernel(SR);
    kernel.noteOn(64 / SR, 0, 0, 1); // due at absolute frame 64
    const buf = new Float32Array(BLOCK);
    kernel.process(buf, BLOCK, 0);
    for (let i = 0; i < 64; i++) expect(buf[i]).toBe(0); // silent before the hit
    let energyAfter = 0;
    for (let i = 64; i < BLOCK; i++) energyAfter += Math.abs(buf[i]);
    expect(energyAfter).toBeGreaterThan(0); // audible after
  });

  it('produces a decaying envelope (loud at onset, quiet a beat later)', () => {
    const kernel = new Kick2Kernel(SR);
    kernel.noteOn(0, 0, 0, 1);
    const out = renderBlocks(kernel, 0, Math.ceil((SR * 1.0) / BLOCK)); // ~1s
    const early = rms(out, 0, SR * 0.05); // first 50ms
    const late = rms(out, SR * 0.7, SR * 0.75); // ~700ms in
    expect(early).toBeGreaterThan(0.05);
    expect(late).toBeLessThan(early * 0.1);
  });

  it('stays finite and within range for a full hit', () => {
    const kernel = new Kick2Kernel(SR);
    kernel.noteOn(0, 0, 0, 1);
    const out = renderBlocks(kernel, 0, Math.ceil((SR * 1.0) / BLOCK));
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Math.abs(out[i])).toBeLessThan(4); // generous headroom guard
    }
  });

  it('tune raises the body pitch (more zero-crossings)', () => {
    function crossings(tune: number): number {
      const kernel = new Kick2Kernel(SR);
      const block = defaultParamBlock();
      block[PARAM_INDEX['tune']] = tune;
      block[PARAM_INDEX['punch']] = 0; // no sweep, so we measure the body pitch directly
      block[PARAM_INDEX['click']] = 0; // no noise to confuse crossing counts
      kernel.applyParams(block);
      kernel.noteOn(0, 0, 0, 1);
      const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.1) / BLOCK));
      let n = 0;
      for (let i = 1; i < SR * 0.05; i++) if (out[i - 1] < 0 && out[i] >= 0) n++;
      return n;
    }
    expect(crossings(100)).toBeGreaterThan(crossings(40));
  });

  it('velocity scales output level', () => {
    function peak(vel: number): number {
      const kernel = new Kick2Kernel(SR);
      kernel.noteOn(0, 0, 0, vel);
      const out = renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK));
      let p = 0;
      for (let i = 0; i < out.length; i++) p = Math.max(p, Math.abs(out[i]));
      return p;
    }
    expect(peak(1)).toBeGreaterThan(peak(0.25));
  });
});
