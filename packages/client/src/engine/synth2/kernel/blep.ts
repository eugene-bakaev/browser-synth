// PolyBLEP residual for band-limiting unit steps in phase-accumulator
// oscillators. Same math as engine/worklets/polyblep.ts (which stays in
// place for the synth1 pulse worklet); the kernel needs its own copy under
// kernel/ because kernel files must stay free of references to worklet-era
// modules and this file is bundled into the synth2 worklet.
//
// t: phase in [0,1) positioned so the discontinuity is at t=0/t=1.
// dt: phase increment per sample (freq / sampleRate).

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
