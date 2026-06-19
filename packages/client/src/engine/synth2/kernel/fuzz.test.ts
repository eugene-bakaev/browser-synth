import { describe, it, expect } from 'vitest';
import { Voice } from './Voice';
import { SYNTH2_DESCRIPTORS, MOD_SOURCES } from '@fiddle/shared';

const SR = 48000;

// Deterministic RNG (mulberry32) so any failure reproduces from the seed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAD_FREQS = [NaN, 0, -1, -440, Infinity, -Infinity, 1e9];
const BAD_VELS = [NaN, -1, 2, Infinity, -Infinity];

describe('Voice fuzz — finite output under randomized params/triggers (I4)', () => {
  it('never emits a non-finite sample across 400 random configurations', () => {
    const rand = rng(0xc0ffee);
    const out = new Float32Array(1024);

    for (let iter = 0; iter < 400; iter++) {
      const v = new Voice(SR, ((iter + 1) * 2654435761) >>> 0);

      // Random param bases; 30% of the time probe outside [min,max] (setBase
      // clamps — this exercises the clamp path).
      SYNTH2_DESCRIPTORS.forEach((d, i) => {
        const span = d.max - d.min || 1;
        const over = rand() < 0.3 ? (rand() - 0.5) * span * 4 : 0;
        v.slots[i].setBase(d.min + rand() * span + over);
      });

      // Random discrete state.
      v.setSync(rand() < 0.5, rand() < 0.5);
      v.setFilterType(Math.floor(rand() * 3));
      v.setFilterModel(rand() < 0.5 ? 0 : 1);
      v.setEnvLoop(rand() < 0.5, rand() < 0.5, rand() < 0.5);

      // All 8 matrix slots wired (raw dest slot index, or -1 for none).
      for (let s = 0; s < 8; s++) {
        const src = Math.floor(rand() * MOD_SOURCES.length);
        const dest = rand() < 0.2 ? -1 : Math.floor(rand() * SYNTH2_DESCRIPTORS.length);
        v.setMatrixSlot(s, src, dest, (rand() - 0.5) * 4);
      }

      // Fuzzed trigger: mix valid and garbage freq/velocity.
      const freq = rand() < 0.5 ? 20 + rand() * 19000 : BAD_FREQS[Math.floor(rand() * BAD_FREQS.length)];
      const vel = rand() < 0.5 ? rand() : BAD_VELS[Math.floor(rand() * BAD_VELS.length)];
      v.noteOn(freq, vel, Math.floor(1 + rand() * SR));

      out.fill(0);
      v.renderAdd(out, 0, out.length);
      for (let i = 0; i < out.length; i++) {
        if (!Number.isFinite(out[i])) {
          throw new Error(`non-finite output at iter=${iter} sample=${i} value=${out[i]}`);
        }
      }
    }
    expect(true).toBe(true); // reached only if every iteration stayed finite
  });
});
