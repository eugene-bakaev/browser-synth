//
// kick2 — worklet bass-drum engine param table + defaults. Lives in @fiddle/shared
// so server-side validation and the project factory can construct/validate a
// default Project without touching DOM-only engine code.
//
// Synthesis model (Gordon Reid, SOS "Synth Secrets", bass-drum installments):
// a sine body with a downward PITCH envelope (the thump) + a separate CLICK
// transient + waveshaper DRIVE for the "thwack", and a DROOP knob modelling the
// TR-808's habit of going slightly flat at long decays. The kernel reads these
// from the Float32Array param block in descriptor order (see client
// engine/kick2/kernel/params.ts).

import { buildDrumDefaults, type DrumParamDescriptor } from './drum-descriptors.js';

// APPEND-ONLY (block index = array position; see drum-descriptors.ts).
export const KICK2_DESCRIPTORS: readonly DrumParamDescriptor[] = [
  { key: 'tune',       min: 30,    max: 120, default: 50,   label: 'Tune',  format: 'hz', curve: 'exp' },
  { key: 'punch',      min: 0,     max: 1,   default: 0.5,  label: 'Punch', format: 'percent' },
  { key: 'pitchDecay', min: 0.005, max: 0.2, default: 0.04, label: 'P.Dec', format: 'ms', curve: 'exp' },
  { key: 'decay',      min: 0.05,  max: 1.5, default: 0.4,  label: 'Decay', format: 'ms', curve: 'exp' },
  { key: 'click',      min: 0,     max: 1,   default: 0.5,  label: 'Click', format: 'percent' },
  { key: 'drive',      min: 0,     max: 1,   default: 0.2,  label: 'Drive', format: 'percent' },
  { key: 'droop',      min: 0,     max: 1,   default: 0,    label: 'Droop', format: 'percent' },
  { key: 'level',      min: 0,     max: 1,   default: 0.9,  label: 'Level', format: 'percent' },
] as const satisfies readonly DrumParamDescriptor[];

export interface Kick2EngineParams {
  /** Base pitch the sweep settles to, Hz. */
  tune: number;
  /** Pitch-envelope depth — how high above `tune` the sweep starts (0..1). */
  punch: number;
  /** Pitch-envelope decay time, seconds. */
  pitchDecay: number;
  /** Amplitude decay time, seconds. */
  decay: number;
  /** Level of the separate noise+pulse click transient (0..1). */
  click: number;
  /** Waveshaper saturation on the body (0..1). */
  drive: number;
  /** TR-808-style "goes flat at long decays" pitch droop (0..1). */
  droop: number;
  /** Output level (0..1). */
  level: number;
}

export const DEFAULT_KICK2_PARAMS: Kick2EngineParams =
  buildDrumDefaults<Kick2EngineParams>(KICK2_DESCRIPTORS);
