// Presentational names for synth2 params, modules, and mod sources — the ONE
// vocabulary the panel knobs, headers, and mod-matrix dropdowns all render
// from (spec: docs/superpowers/specs/2026-07-15-synth2-label-unification-design.md).
// Nothing here touches the wire: MOD_SOURCES/MOD_DESTS keep encoding raw keys.

import { SYNTH2_DESCRIPTORS, type Synth2ModSource } from './synth2-descriptors.js';

/** Module prefix for composed dest labels. null = render the param label bare
 *  (the fm rows carry their own routing name, 'FM 1→2'). */
export const SYNTH2_MODULE_LABELS: Readonly<Record<string, string | null>> = {
  osc1: 'Osc 1', osc2: 'Osc 2', osc3: 'Osc 3',
  noise: 'Noise', fm: null,
  env1: 'Env 1', env2: 'Env 2', env3: 'Env 3',
  filter: 'Filter', lfo1: 'LFO 1', lfo2: 'LFO 2',
};

/** What each numbered envelope is for. Composed into matrix source labels
 *  ('Env 1 (Amp)') and panel headers ('ENV 1 · AMP') — written exactly once. */
export const SYNTH2_ENV_ROLES: Readonly<Record<'env1' | 'env2' | 'env3', string>> = {
  env1: 'Amp', env2: 'Filter', env3: 'Mod',
};

export const MOD_SOURCE_LABELS: Readonly<Record<Synth2ModSource, string>> = {
  none: 'None',
  lfo1: 'LFO 1',
  lfo2: 'LFO 2',
  env1: `Env 1 (${SYNTH2_ENV_ROLES.env1})`,
  env2: `Env 2 (${SYNTH2_ENV_ROLES.env2})`,
  env3: `Env 3 (${SYNTH2_ENV_ROLES.env3})`,
  velocity: 'Velocity',
  noise: 'Noise',
};

const byKey = new Map(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));

/** Mod-matrix dest option text: 'none' → 'None'; else module label + param
 *  label ('Osc 1 Octave'), bare param label when the module prefix is null
 *  ('FM 1→2'). Unknown keys fall back to the raw key so an old client never
 *  renders blank options against newer data. */
export const modDestLabel = (key: string): string => {
  if (key === 'none') return 'None';
  const d = byKey.get(key);
  if (!d) return key;
  const prefix = SYNTH2_MODULE_LABELS[key.split('.')[0]];
  return prefix ? `${prefix} ${d.label}` : d.label;
};

/** Knob-face text for a descriptor key: the terse variant when one exists
 *  ('A' for env stages), else the full label. Falls back to the raw key. */
export const knobLabel = (key: string): string => {
  const d = byKey.get(key);
  return d ? (d.shortLabel ?? d.label) : key;
};
