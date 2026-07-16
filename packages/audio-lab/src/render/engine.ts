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
