import { FreeRunOscillator } from './FreeRunOscillator';
import { PhaseOffsetOscillator } from './PhaseOffsetOscillator';
import type { IOscillatorModule, OscMode } from './types';

export type { IOscillatorModule, OscMode } from './types';
export { FreeRunOscillator } from './FreeRunOscillator';
export { PhaseOffsetOscillator } from './PhaseOffsetOscillator';

// Dispatch by mode. T2 wires phase-offset; T3 will wire retrigger-recreate
// and T4 will wire retrigger-wavetable. The fall-through default keeps the
// app shippable mid-experiment if an unknown mode string sneaks in.
export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule {
  switch (mode) {
    case 'phase-offset':
      return new PhaseOffsetOscillator(ctx);
    case 'free-run':
    case 'retrigger-recreate':       // T3 wires this branch
    case 'retrigger-wavetable':      // T4 wires this branch
    default:
      return new FreeRunOscillator(ctx);
  }
}
