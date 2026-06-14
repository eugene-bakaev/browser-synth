//
// SoundEngine implementation for the worklet synth (spec §6.1/§6.6). One
// AudioWorkletNode per engine instance; ALL communication is MessagePort
// messages (no AudioParams). The engine keeps a Float32Array mirror of the
// param block (descriptor order — see kernel/params.ts) and posts a copy
// whenever applyParams changes anything.
//
// External graph shape matches every other engine: node → out GainNode →
// destination, so useSynth's D4 engine-swap fade works unchanged.
//
// PREREQUISITE: ctx.audioWorklet.addModule(synth2 worklet URL) must have
// resolved before construction — same invariant as the pulse worklet; both
// are awaited in useSynth.buildAudioState.

import { SoundEngine } from './types';
import { DEFAULT_SYNTH2_PARAMS, encodeBool, encodeEnum, MOD_SOURCES, SYNTH2_ENUM_VALUES, type Synth2EngineParams } from '@fiddle/shared';
import { PARAM_INDEX, MATRIX_BASE, MATRIX_SLOTS, MATRIX_STRIDE, defaultParamBlock } from './synth2/kernel/params';

export class Synth2Engine implements SoundEngine {
  readonly engineType = 'synth2';
  readonly ctx: AudioContext;

  static readonly DEFAULT_PARAMS: Synth2EngineParams = DEFAULT_SYNTH2_PARAMS;

  private readonly node: AudioWorkletNode;
  private readonly out: GainNode;
  private readonly block = defaultParamBlock();

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'synth2', {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.node.connect(this.out);
    this.out.connect(destination ?? ctx.destination);
  }

  applyParams(params: Record<string, any>): void {
    let changed = false;
    for (const [mod, fields] of Object.entries(params)) {
      // Matrix is an array (not a nested module object): skip here, encode below.
      if (mod === 'matrix') continue;
      if (typeof fields !== 'object' || fields === null) continue;
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        const idx = PARAM_INDEX[`${mod}.${field}`];
        if (idx === undefined) continue;
        // Continuous params arrive as numbers; discrete bools as true/false
        // (encoded 0/1); enum leaves as their string value (encoded to the
        // descriptor's index). Top-level strings (mode) never reach this nested
        // loop, so an unrecognised string here is skipped defensively.
        // Float32Array stores 32-bit values; Math.fround converts the incoming
        // number to the same precision before comparing so the no-op path works
        // even when DEFAULT_SYNTH2_PARAMS values have 64-bit fractions that
        // round to the same float32 as the stored block entry.
        let f32: number;
        if (typeof value === 'number') {
          f32 = Math.fround(value);
        } else if (typeof value === 'boolean') {
          f32 = encodeBool(value);
        } else if (typeof value === 'string') {
          const values = SYNTH2_ENUM_VALUES[`${mod}.${field}`];
          if (!values) continue;
          f32 = encodeEnum(value, values);
        } else {
          continue;
        }
        if (this.block[idx] === f32) continue;
        this.block[idx] = f32;
        changed = true;
      }
    }
    // Matrix is an array of routes (not a nested module object): encode each
    // slot into the block's matrix region. source → MOD_SOURCES index; dest →
    // PARAM_INDEX(key)+1 (0 = none, append-stable); amount → float32.
    const matrix = params.matrix;
    if (Array.isArray(matrix)) {
      for (let s = 0; s < MATRIX_SLOTS; s++) {
        const slot = matrix[s];
        if (!slot) continue;
        const base = MATRIX_BASE + s * MATRIX_STRIDE;
        const srcIdx = Math.max(0, (MOD_SOURCES as readonly string[]).indexOf(slot.source ?? 'none'));
        const destKey = slot.dest ?? 'none';
        const destEnc = destKey === 'none' || PARAM_INDEX[destKey] === undefined ? 0 : PARAM_INDEX[destKey] + 1;
        const amt = Math.fround(typeof slot.amount === 'number' ? slot.amount : 0);
        if (this.block[base] !== srcIdx) { this.block[base] = srcIdx; changed = true; }
        if (this.block[base + 1] !== destEnc) { this.block[base + 1] = destEnc; changed = true; }
        if (this.block[base + 2] !== amt) { this.block[base + 2] = amt; changed = true; }
      }
    }
    if (changed) {
      this.node.port.postMessage({ type: 'params', block: this.block.slice() });
    }
  }

  trigger(freq: number | number[], duration: number, time?: number, velocity: number = 1.0): void {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = time ?? this.ctx.currentTime;
    if (Array.isArray(freq)) {
      // Poly: one message per note; the kernel allocator spreads them across voices.
      for (const f of freq) {
        this.node.port.postMessage({ type: 'trigger', time: t, freq: f, duration, velocity, mono: false });
      }
    } else {
      // Mono: voice 0 retrigger.
      this.node.port.postMessage({ type: 'trigger', time: t, freq, duration, velocity, mono: true });
    }
  }

  dispose(): void {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.out.disconnect();
  }
}
