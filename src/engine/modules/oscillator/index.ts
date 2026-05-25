import { FreeRunOscillator } from './FreeRunOscillator';
import type { IOscillatorModule, OscMode } from './types';

export type { IOscillatorModule, OscMode } from './types';
export { FreeRunOscillator } from './FreeRunOscillator';

// Dispatch by mode. T1 wires FreeRun for every value — the non-free-run
// branches will be replaced in T2/T3/T4. The fall-through default keeps the
// app shippable mid-experiment if an unknown mode string sneaks in.
export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule {
  switch (mode) {
    case 'free-run':
    case 'phase-offset':
    case 'retrigger-recreate':
    case 'retrigger-wavetable':
    default:
      return new FreeRunOscillator(ctx);
  }
}
