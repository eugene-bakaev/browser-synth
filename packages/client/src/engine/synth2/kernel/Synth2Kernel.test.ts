import { describe, it, expect } from 'vitest';
import { Synth2Kernel } from './Synth2Kernel';
import { PARAM_INDEX, PARAM_COUNT, defaultParamBlock, MATRIX_BASE, MATRIX_STRIDE } from './params';
import { SYNTH2_DESCRIPTORS, MOD_SOURCES } from '@fiddle/shared';

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

  it('applyParams reaches the audio: osc1.level+osc2.level 0 silences a held note', () => {
    const kernel = new Synth2Kernel(SR);
    kernel.noteOn(0, 440, 2, 1);
    renderBlocks(kernel, 0, 8); // note sounding
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc1.level']] = 0;
    block[PARAM_INDEX['osc2.level']] = 0;
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

describe('Synth2Kernel oscillator section', () => {
  // Pre-render enough blocks (with an active voice) to let the 5ms param
  // smoothers settle from their descriptor defaults. Without this, osc2.level
  // (default 0.8) creates a transient when zeroed in a fresh kernel, which
  // contaminates the "off" (silence) assertions. Smoothers only advance inside
  // renderAdd, so we need an active voice during settling.
  const SETTLE_FRAMES = Math.ceil(SR * 0.1); // 100ms ≫ 7 × 5ms time constants
  const SETTLE_BLOCKS_COUNT = Math.ceil(SETTLE_FRAMES / BLOCK);

  function renderEnergy(setup: (b: Float32Array) => void): number {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    setup(block);
    k.applyParams(block);
    // Fire a long note during the settle window, then measure a fresh note.
    k.noteOn(0, 220, 10, 1, true); // long gate: survives settle window
    const settle = new Float32Array(BLOCK);
    for (let i = 0; i < SETTLE_BLOCKS_COUNT; i++) k.process(settle, BLOCK, i * BLOCK);
    // Now fire the measurement note (retrigger mono voice 0) at settle end.
    const measureStart = SETTLE_BLOCKS_COUNT * BLOCK;
    k.noteOn(measureStart / SR, 220, 1, 1, true);
    const out = renderBlocks(k, measureStart, 16);
    let e = 0; for (let i = 0; i < out.length; i++) e += Math.abs(out[i]);
    return e;
  }

  it('osc2 level contributes audio (energy rises when osc2.level goes up from 0)', () => {
    const lo = renderEnergy(b => { b[PARAM_INDEX['osc2.level']] = 0; });
    const hi = renderEnergy(b => { b[PARAM_INDEX['osc2.level']] = 1; });
    expect(hi).toBeGreaterThan(lo * 1.05);
  });

  it('osc3 is silent at level 0 and audible above it', () => {
    const off = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['osc2.level']] = 0; b[PARAM_INDEX['osc3.level']] = 0; });
    const on  = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['osc2.level']] = 0; b[PARAM_INDEX['osc3.level']] = 1; });
    expect(off).toBeLessThan(1e-3);
    expect(on).toBeGreaterThan(0.1);
  });

  it('noise contributes broadband energy when noise.level > 0', () => {
    // osc2 defaults to 0.8; zero it alongside osc1 to isolate the noise channel.
    const off = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['osc2.level']] = 0; b[PARAM_INDEX['noise.level']] = 0; });
    const on  = renderEnergy(b => { b[PARAM_INDEX['osc1.level']] = 0; b[PARAM_INDEX['osc2.level']] = 0; b[PARAM_INDEX['noise.level']] = 1; });
    expect(off).toBeLessThan(1e-3);
    expect(on).toBeGreaterThan(0.1);
  });

  // Seed independence itself is proven in Noise.test.ts ("different seeds diverge");
  // here we just confirm both poly voices reach the mix through the noise channel.
  it('two poly voices both produce noise output', () => {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc1.level']] = 0; block[PARAM_INDEX['osc2.level']] = 0;
    block[PARAM_INDEX['noise.level']] = 1;
    k.applyParams(block);
    k.noteOn(0, 220, 1, 1, false); // poly → voice A
    k.noteOn(0, 440, 1, 1, false); // poly → voice B
    const out = renderBlocks(k, 0, 8);
    let e = 0; for (let i = 0; i < out.length; i++) e += Math.abs(out[i]);
    expect(e).toBeGreaterThan(0.1);
  });

  it('TZFM changes osc2 output (fm.osc2 > 0 alters the result vs fm.osc2 = 0)', () => {
    const noFm = renderEnergy(b => { b[PARAM_INDEX['fm.osc2']] = 0; });
    const fm   = renderEnergy(b => { b[PARAM_INDEX['fm.osc2']] = 3; });
    expect(Math.abs(fm - noFm)).toBeGreaterThan(0.01);
  });
});

describe('Synth2Kernel hard sync', () => {
  /** Normalized autocorrelation at `lag` samples. */
  function autocorr(buf: Float32Array, lag: number): number {
    const n = buf.length - lag;
    let num = 0, den0 = 0, den1 = 0;
    for (let i = 0; i < n; i++) {
      num += buf[i] * buf[i + lag];
      den0 += buf[i] * buf[i];
      den1 += buf[i + lag] * buf[i + lag];
    }
    const den = Math.sqrt(den0 * den1);
    return den > 0 ? num / den : 0;
  }

  // Silence osc1/osc3/noise; osc1 still RUNS as the sync master.
  // osc2 is detuned +7 semitones (~1.5×, free ≈ 330 Hz) so its natural period
  // clearly differs from the 220 Hz master. Settled for 100ms so the coarse
  // smoother has converged before we measure.
  function renderOsc2Only(syncOn: boolean): Float32Array {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc1.level']] = 0;
    block[PARAM_INDEX['osc3.level']] = 0;
    block[PARAM_INDEX['noise.level']] = 0;
    block[PARAM_INDEX['osc2.level']] = 1;
    block[PARAM_INDEX['osc2.coarse']] = 7;          // +7 semitones (~1.5×)
    block[PARAM_INDEX['osc2.sync']] = syncOn ? 1 : 0;
    k.applyParams(block);
    k.noteOn(0, 220, 10, 1, true);                  // mono, 220 Hz master pitch, long gate
    // Let param smoothers converge (100ms >> 5ms time constant)
    const settleBlocks = Math.ceil(SR * 0.1 / BLOCK);
    renderBlocks(k, 0, settleBlocks);
    // Measure ~1s
    const measureStart = settleBlocks * BLOCK;
    return renderBlocks(k, measureStart, Math.ceil(SR / BLOCK));
  }

  it('osc2.sync locks osc2 to the played (master) pitch', () => {
    // Hard sync forces the waveform to REPEAT at the master period (220 Hz),
    // not the slave's natural period (330 Hz). Autocorrelation detects this:
    // the synced signal should correlate strongly at masterLag but NOT slaveLag;
    // the free signal should correlate strongly at slaveLag but NOT masterLag.
    const masterLag = Math.round(SR / 220); // ~218 samples
    const slaveLag  = Math.round(SR / 330); // ~145 samples

    const freeOut = renderOsc2Only(false);
    const syncOut = renderOsc2Only(true);

    const freeAtSlave  = autocorr(freeOut, slaveLag);   // ~1.0 (periodic at 330 Hz)
    const freeAtMaster = autocorr(freeOut, masterLag);  // ~-0.5 (not 220 Hz periodic)
    const syncAtMaster = autocorr(syncOut, masterLag);  // ~0.999 (locked to master)
    const syncAtSlave  = autocorr(syncOut, slaveLag);   // ~0.0 (not slave-periodic)

    // Free osc2: autocorrelated at its own period (330 Hz), not the master
    expect(freeAtSlave).toBeGreaterThan(0.95);
    expect(freeAtMaster).toBeLessThan(0.5);
    // Synced osc2: autocorrelated at the master period (220 Hz), not its own
    expect(syncAtMaster).toBeGreaterThan(0.95);
    expect(syncAtSlave).toBeLessThan(0.5);
  });

  it('renders finite, bounded audio with sync on', () => {
    const out = renderOsc2Only(true);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    expect(peak).toBeLessThan(2);
    expect(peak).toBeGreaterThan(0);
  });
});

describe('Synth2Kernel classic filter', () => {
  // Isolate osc1 (saw) → filter; silence osc2/osc3/noise; play a 220 Hz note.
  function render(opts: {
    cutoff?: number; type?: number; envAmount?: number; keyTrack?: number; freq?: number;
  }): Float32Array {
    const k = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc2.level']] = 0;
    block[PARAM_INDEX['osc3.level']] = 0;
    block[PARAM_INDEX['noise.level']] = 0;
    block[PARAM_INDEX['osc1.level']] = 1;
    block[PARAM_INDEX['osc1.morph']] = 2;                  // saw — rich harmonics
    block[PARAM_INDEX['filter.cutoff']] = opts.cutoff ?? 2000;
    block[PARAM_INDEX['filter.type']] = opts.type ?? 0;    // lp
    block[PARAM_INDEX['filter.envAmount']] = opts.envAmount ?? 0;
    block[PARAM_INDEX['filter.keyTrack']] = opts.keyTrack ?? 0;
    k.applyParams(block);
    k.noteOn(0, opts.freq ?? 220, 2, 1, true);             // mono
    return renderBlocks(k, 0, Math.ceil(SR / BLOCK));      // ~1s
  }
  function rms(buf: Float32Array): number {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }
  function diff(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  it('a low cutoff attenuates more energy than a high cutoff', () => {
    // 80 Hz cutoff is well below the 220 Hz fundamental (~1.5 oct below);
    // 8000 Hz is well above all prominent harmonics of a 220 Hz saw.
    // Using 18000 Hz near Nyquist (SR=48000) is unreliable because the ZDF
    // SVF's tan pre-warp g > 1 at that freq causes unexpected attenuation.
    const closed = rms(render({ cutoff: 80 }));
    const open = rms(render({ cutoff: 8000 }));
    expect(closed).toBeLessThan(open * 0.6);
    expect(closed).toBeGreaterThan(0);
  });

  it('lp and hp produce different output at the same cutoff', () => {
    const lp = render({ cutoff: 1000, type: 0 });
    const hp = render({ cutoff: 1000, type: 2 });
    expect(diff(lp, hp)).toBeGreaterThan(1e-3);
  });

  it('keytrack raises the effective cutoff with pitch', () => {
    const tracked = rms(render({ cutoff: 400, type: 0, keyTrack: 1, freq: 880 }));
    const untracked = rms(render({ cutoff: 400, type: 0, keyTrack: 0, freq: 880 }));
    expect(tracked).toBeGreaterThan(untracked * 1.2);
  });

  it('envAmount changes the sound (env2 → cutoff)', () => {
    const flat = render({ cutoff: 300, type: 0, envAmount: 0 });
    const swept = render({ cutoff: 300, type: 0, envAmount: 4 });
    expect(diff(flat, swept)).toBeGreaterThan(1e-3);
  });

  it('renders finite, bounded audio with the filter engaged', () => {
    const out = render({ cutoff: 1200, type: 0, envAmount: 2.4 });
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    expect(peak).toBeLessThan(4);
    expect(peak).toBeGreaterThan(0);
  });
});

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

describe('Synth2Kernel mod matrix (I3a)', () => {
  // Render 2048 samples mono with a given param block and return RMS energy.
  function renderRms(block: Float32Array): number {
    const k = new Synth2Kernel(SR);
    k.applyParams(block);
    // noteOn(time, freq, duration, velocity, mono)
    // time=0 (absolute seconds on ctx clock → frame 0), mono=true
    k.noteOn(0, 220, 1.0, 1.0, true);
    const out = new Float32Array(2048);
    k.process(out, 2048, 0);
    let rms = 0;
    for (const x of out) rms += x * x;
    return Math.sqrt(rms / out.length);
  }

  it('applyParams routes a matrix slot from the block (velocity → osc1.level) (I3a)', () => {
    // Without a route the default block sets osc1.level to its descriptor default.
    // With velocity→osc1.level at amount=1, the mod adds velocity (1.0) to the
    // base osc1.level, making the output louder (more energy).
    const blockNoRoute = defaultParamBlock();

    const blockWithRoute = defaultParamBlock();
    const base = MATRIX_BASE + 0 * MATRIX_STRIDE;
    blockWithRoute[base]     = MOD_SOURCES.indexOf('velocity'); // source index
    blockWithRoute[base + 1] = PARAM_INDEX['osc1.level'] + 1;  // destEncoded (+1)
    blockWithRoute[base + 2] = 1;                               // amount

    const rmsNoRoute   = renderRms(blockNoRoute);
    const rmsWithRoute = renderRms(blockWithRoute);

    expect(rmsWithRoute).toBeGreaterThan(rmsNoRoute);
  });
});

describe('Synth2Kernel env loop decode (I3c)', () => {
  const SR = 48000;

  it('decodes env3.loop and drives it to the voices (looping env3 mod differs from non-looping)', () => {
    const env3Src = MOD_SOURCES.indexOf('env3');
    const levelIdx = PARAM_INDEX['osc1.level'];
    const render = (loopVal: number) => {
      const k = new Synth2Kernel(SR);
      const block = defaultParamBlock();
      block[PARAM_INDEX['env3.a']] = 0.005;
      block[PARAM_INDEX['env3.d']] = 0.01;
      block[PARAM_INDEX['env3.s']] = 0;
      block[PARAM_INDEX['env3.loop']] = loopVal;
      // matrix slot 0: env3 → osc1.level, amount 1 (destEnc = PARAM_INDEX + 1)
      const base = MATRIX_BASE + 0 * MATRIX_STRIDE;
      block[base] = env3Src;
      block[base + 1] = levelIdx + 1;
      block[base + 2] = 1;
      k.applyParams(block);
      k.noteOn(0, 220, 1, 1, true);
      const out = new Float32Array(8192);
      k.process(out, 8192, 0);
      return out;
    };
    const off = render(0), on = render(1);
    let maxDiff = 0;
    for (let i = 0; i < off.length; i++) maxDiff = Math.max(maxDiff, Math.abs(off[i] - on[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });
});
