// packages/client/src/engine/synth2/kernel/allocator.ts
//
// Voice allocation policy (spec §5.6): prefer a FREE voice, scanning round-robin
// from rrStart so successive notes spread across the pool; when every voice is
// busy, STEAL the oldest active one (smallest age stamp). Pure + allocation-free
// so the kernel's hot path stays GC-clean and the policy is unit-testable.

export const VOICE_COUNT = 8;

/**
 * @param active per-voice activity (length VOICE_COUNT)
 * @param ages   per-voice age stamp; smaller = older (length VOICE_COUNT)
 * @param rrStart round-robin scan origin
 * @returns index of the voice to (re)trigger
 */
export function pickVoice(active: boolean[], ages: number[], rrStart: number): number {
  const n = active.length;
  for (let k = 0; k < n; k++) {
    const v = (rrStart + k) % n;
    if (!active[v]) return v;
  }
  // None free → steal the oldest active.
  let oldest = 0;
  for (let v = 1; v < n; v++) {
    if (ages[v] < ages[oldest]) oldest = v;
  }
  return oldest;
}
