import { FreeRunOscillator } from './FreeRunOscillator';
import { PhaseOffsetOscillator } from './PhaseOffsetOscillator';
import { RetriggerOscillator } from './RetriggerOscillator';
import { WavetableOscillator } from './WavetableOscillator';
import type { IOscillatorModule, OscMode } from './types';

export type { IOscillatorModule, OscMode } from './types';
export { FreeRunOscillator } from './FreeRunOscillator';
export { PhaseOffsetOscillator } from './PhaseOffsetOscillator';
export { RetriggerOscillator } from './RetriggerOscillator';
export { WavetableOscillator } from './WavetableOscillator';

// Dispatch by mode. T2 wires phase-offset; T3 wires retrigger-recreate;
// T4 wires retrigger-wavetable. After T4, every OscMode value reaches
// its intended implementation.
export function makeOscillator(mode: OscMode, ctx: AudioContext): IOscillatorModule {
  switch (mode) {
    case 'phase-offset':
      return new PhaseOffsetOscillator(ctx);
    case 'retrigger-recreate':
      return new RetriggerOscillator(ctx);
    case 'retrigger-wavetable':
      return new WavetableOscillator(ctx);
    case 'free-run':
    default:
      return new FreeRunOscillator(ctx);
  }
}
