// Human-readable label for the Tracker's fixed second header row. Synth
// distinguishes mono/poly; the drum engines (kick/hat/snare/clap) have no
// sub-mode, so the engine name alone is the label.
export function engineLabel(engineType: string, mode?: 'mono' | 'poly'): string {
  if (engineType === 'synth') {
    return mode === 'poly' ? 'SYNTH · POLY' : 'SYNTH · MONO';
  }
  return engineType.toUpperCase();
}
