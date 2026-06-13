import { describe, it, expect } from 'vitest';
import { Synth2Kernel } from './Synth2Kernel';
import { PARAM_INDEX, PARAM_COUNT, defaultParamBlock } from './params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

function renderBlocks(kernel: Synth2Kernel, startFrame: number, blocks: number): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  const buf = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    kernel.process(buf, BLOCK, startFrame + b * BLOCK);
    out.set(buf, b * BLOCK);
  }
  return out;
}

describe('params block layout', () => {
  it('one index per descriptor, in table order', () => {
    expect(PARAM_COUNT).toBe(SYNTH2_DESCRIPTORS.length);
    SYNTH2_DESCRIPTORS.forEach((d, i) => expect(PARAM_INDEX[d.key]).toBe(i));
    const block = defaultParamBlock();
    // Float32Array stores values at float32 precision (~7 significant digits);
    // use toBeCloseTo(v, 6) rather than toBe to handle the float32 truncation.
    SYNTH2_DESCRIPTORS.forEach((d, i) => expect(block[i]).toBeCloseTo(d.default, 6));
  });
});

describe('Synth2Kernel', () => {
  it('renders exact silence (and stays finite) with no notes', () => {
    const out = renderBlocks(new Synth2Kernel(SR), 0, 8);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('starts a note at the exact frame offset inside a block', () => {
    const kernel = new Synth2Kernel(SR);
    // note due at absolute frame 64 — mid-block when the block starts at 0
    kernel.noteOn(64 / SR, 440, 0.5, 1);
    const buf = new Float32Array(BLOCK);
    kernel.process(buf, BLOCK, 0);
    for (let i = 0; i < 64; i++) expect(buf[i]).toBe(0);
    let energyAfter = 0;
    for (let i = 64; i < BLOCK; i++) energyAfter += Math.abs(buf[i]);
    expect(energyAfter).toBeGreaterThan(0);
  });

  it('a past-due event starts immediately (graceful degradation)', () => {
    const kernel = new Synth2Kernel(SR);
    kernel.noteOn(0, 440, 0.5, 1); // due at frame 0…
    const buf = new Float32Array(BLOCK);
    kernel.process(buf, BLOCK, 1024); // …but the clock is already at 1024
    let energy = 0;
    for (let i = 0; i < BLOCK; i++) energy += Math.abs(buf[i]);
    expect(energy).toBeGreaterThan(0);
  });

  it('voice gates back to exact zeros after the release tail', () => {
    const kernel = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['env1.r']] = 0.01;
    kernel.applyParams(block);
    kernel.noteOn(0, 440, 0.05, 1); // 50ms gate + 10ms release
    renderBlocks(kernel, 0, Math.ceil((SR * 0.1) / BLOCK)); // 100ms ≫ tail
    const after = renderBlocks(kernel, SR, 4);
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(0);
  });

  it('applyParams reaches the audio: osc1.level 0 silences a held note', () => {
    const kernel = new Synth2Kernel(SR);
    kernel.noteOn(0, 440, 2, 1);
    renderBlocks(kernel, 0, 8); // note sounding
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc1.level']] = 0;
    kernel.applyParams(block);
    renderBlocks(kernel, 8 * BLOCK, Math.ceil((SR * 0.05) / BLOCK)); // ride out smoothing
    const after = renderBlocks(kernel, SR, 1);
    let peak = 0;
    for (let i = 0; i < after.length; i++) peak = Math.max(peak, Math.abs(after[i]));
    expect(peak).toBeLessThan(1e-3);
  });

  it('velocity scales output amplitude', () => {
    const loud = new Synth2Kernel(SR);
    const quiet = new Synth2Kernel(SR);
    loud.noteOn(0, 440, 1, 1);
    quiet.noteOn(0, 440, 1, 0.25);
    const a = renderBlocks(loud, 0, 16);
    const b = renderBlocks(quiet, 0, 16);
    let pa = 0, pb = 0;
    for (let i = 0; i < a.length; i++) { pa = Math.max(pa, Math.abs(a[i])); pb = Math.max(pb, Math.abs(b[i])); }
    expect(pb).toBeGreaterThan(0);
    expect(pb / pa).toBeCloseTo(0.25, 1);
  });
});

function activeCount(kernel: Synth2Kernel): number {
  return (kernel as any).voices.filter((v: any) => v.active).length;
}

describe('Synth2Kernel polyphony', () => {
  it('sounds 8 simultaneous poly voices and never grows past 8', () => {
    const kernel = new Synth2Kernel(SR);
    for (let i = 0; i < 12; i++) kernel.noteOn(0, 220 + i * 30, 2, 1, false); // mono=false → poly
    renderBlocks(kernel, 0, 4);
    expect((kernel as any).voices.length).toBe(8);
    expect(activeCount(kernel)).toBe(8); // 12 notes, 8 voices, oldest stolen
  });

  it('mono triggers only ever use voice 0', () => {
    const kernel = new Synth2Kernel(SR);
    kernel.noteOn(0, 220, 2, 1, true);
    kernel.noteOn(0, 330, 2, 1, true);
    kernel.noteOn(0, 440, 2, 1, true);
    renderBlocks(kernel, 0, 4);
    expect((kernel as any).voices[0].active).toBe(true);
    expect(activeCount(kernel)).toBe(1);
  });

  it('prefers a freed voice over stealing (free-first)', () => {
    const kernel = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['env1.r']] = 0.001;
    kernel.applyParams(block);
    kernel.noteOn(0, 220, 0.01, 1, false); // very short — will free quickly
    kernel.noteOn(0, 330, 2, 1, false);    // long — stays active
    renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK)); // let the short note finish
    expect(activeCount(kernel)).toBe(1);   // only the long note remains
    // Pin the long note's voice while it is the sole active one, so we can
    // prove it SURVIVES the next allocation (a steal-active bug would silence it).
    const voices = (kernel as any).voices as { active: boolean }[];
    const longVoice = voices.findIndex(v => v.active);
    kernel.noteOn(SR * 0.2 / SR, 440, 2, 1, false);
    renderBlocks(kernel, Math.ceil((SR * 0.2) / BLOCK) * BLOCK, 4);
    // Free-first reused an idle voice; the long note is untouched. A bug that
    // stole the oldest active voice would leave activeCount 1 and longVoice idle.
    expect(activeCount(kernel)).toBe(2);
    expect(voices[longVoice].active).toBe(true);
  });
});
