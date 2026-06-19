import { describe, it, expect } from 'vitest';
import { Synth2Kernel } from './Synth2Kernel';
import { defaultParamBlock, PARAM_INDEX, MATRIX_BASE, MATRIX_STRIDE } from './params';
import { MOD_SOURCES } from '@fiddle/shared';

const SR = 48000;
const BLOCK = 128;

// GC-before-and-after measures RETAINED growth (leaks); transient garbage is
// collected and not counted. Transient zero-alloc is a code-review invariant
// (spec sec 10); this locks against accidental per-block retention.
// The client tsconfig omits @types/node, so reach Node globals through a
// locally-typed globalThis cast (same shape the gc probe below uses) rather
// than the ambient `process`/`gc` names.
const g = globalThis as {
  gc?: () => void;
  process?: { memoryUsage(): { heapUsed: number } };
};
const gc = g.gc;
const heapUsed = () => g.process!.memoryUsage().heapUsed;
// Skip unless BOTH gc and process are present (forks pool gives both together);
// gating on gc alone could let heapUsed() throw instead of skipping.
const maybe = gc && g.process ? it : it.skip; // run with --expose-gc (vite.config wires it)

describe('Synth2Kernel zero-alloc soak (I4)', () => {
  maybe('does not retain heap across 10k process() blocks (8 voices, dense matrix)', () => {
    const kernel = new Synth2Kernel(SR);

    // Dense config: all 8 matrix slots wired (lfo1 -> filter.cutoff).
    const block = defaultParamBlock();
    for (let s = 0; s < 8; s++) {
      const base = MATRIX_BASE + s * MATRIX_STRIDE;
      block[base] = MOD_SOURCES.indexOf('lfo1');         // srcIdx
      block[base + 1] = PARAM_INDEX['filter.cutoff'] + 1; // destEnc (= slot + 1)
      block[base + 2] = 0.5;                              // amount
    }
    kernel.applyParams(block);

    // 8 poly voices, 100s gates so they stay active through the whole run.
    for (let i = 0; i < 8; i++) kernel.noteOn(0, 110 * (i + 1), 100, 1, false);

    const buf = new Float32Array(BLOCK);
    const run = (n: number) => { for (let b = 0; b < n; b++) kernel.process(buf, BLOCK, b * BLOCK); };

    run(200);                 // warm up the JIT
    gc!();
    const before = heapUsed();
    run(10000);
    gc!();
    const after = heapUsed();

    // A real per-block retention (e.g. a 512-byte array x 10k = 5 MB) dwarfs this;
    // the generous absolute bound absorbs JIT/harness noise.
    expect(after - before).toBeLessThan(512 * 1024);
  }, 30_000); // 10k dense blocks run ~5-6s; default 5s testTimeout is too tight.
});
