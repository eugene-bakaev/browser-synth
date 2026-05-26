// PolyBLEP — Polynomial Band-Limited Step.
//
// Anti-aliasing correction for a unit step discontinuity in a periodic
// signal. Reference: V. Välimäki & A. Huovilainen, "Antialiasing Oscillators
// in Subtractive Synthesis", IEEE Signal Processing Magazine, 2007.
//
// Given normalized phase t ∈ [0, 1) and per-sample phase increment dt:
//   - Near t=0 (the step location): apply a smooth polynomial run-up.
//   - Near t=1 (one sample before the next step): apply a smooth run-down.
//   - Otherwise: zero (no correction needed).
//
// The caller composes naive bipolar pulse output with two BLEPs per cycle
// (one at the rising edge, one at the falling edge).
//
// IMPORTANT: this is the canonical implementation. The worklet processor
// (./pulse-processor.js) inlines a byte-for-byte equivalent because audio
// worklet module imports are not consistently supported across browser/
// bundler combinations. If either implementation changes, update both.
export function polyBLEP(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
