// Safety margin past the amp envelope release time for retrigger-mode
// oscillator stops. Both RetriggerOscillator and WavetableOscillator
// schedule stop(releaseTime + STOP_TAIL_SECONDS). Lifted here so the
// two impls cannot drift.
export const STOP_TAIL_SECONDS = 0.05;
