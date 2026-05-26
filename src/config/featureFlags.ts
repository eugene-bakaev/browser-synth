// Build-time feature flags. Flip the constant, restart dev / rebuild.
//
// OSC_PHASE_EXPERIMENT: gates the swappable oscillator section (phase-offset,
// retrigger-recreate, retrigger-wavetable). Default off — the experiment did
// not yield convincing audible differences and is parked behind this flag for
// future revisits without uprooting the engine code.
//
// When false: the OSC MODE select and per-osc Phase knobs are hidden, and
// loaded projects / presets with a non-free-run oscMode are coerced back to
// 'free-run' at the reconciler boundary. Phase values in the data are left
// alone (free-run ignores them) so flipping the flag back on restores the
// saved state.
export const OSC_PHASE_EXPERIMENT = false;
