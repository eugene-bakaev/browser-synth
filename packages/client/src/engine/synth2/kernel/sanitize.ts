//
// I4 Layer 2 (spec §4): production safety net. Sweep a render buffer and
// replace any non-finite sample with 0, returning how many were flushed
// (observability — a non-zero count in normal operation signals an unguarded
// NaN source that the Layer-1 root-cause coercion missed). One Number.isFinite
// per output sample: 128/block, independent of voice count.
//

export function flushNonFinite(out: Float32Array, frames: number): number {
  let flushed = 0;
  for (let i = 0; i < frames; i++) {
    if (!Number.isFinite(out[i])) {
      out[i] = 0;
      flushed++;
    }
  }
  return flushed;
}
