//
// THE single source of truth for synth2 parameters (spec §6.4). Everything
// else derives from this table: the Zod schema + leaf validators (schema.ts),
// the accept-list patterns (accept-list.ts), DEFAULT_SYNTH2_PARAMS (synth2.ts),
// the kernel's Float32Array param-block layout (client kernel/params.ts), and
// panel knob ranges. Contract tests in each consumer assert the derivation.
//
// APPEND-ONLY once I1 merges: the param block index is the array position, so
// inserting/reordering would silently scramble every older client's params.

export type Synth2Taper = 'linear' | 'expOctaves';

export interface Synth2ParamDescriptor {
  /** '<module>.<field>' — also the wire-path tail under engines.synth2 */
  key: string;
  min: number;
  max: number;
  default: number;
  /** How modulation is applied in the kernel (spec §6.3). Base values are linear. */
  taper: Synth2Taper;
  /** Whether the mod matrix (I3) may target this slot. */
  modulatable: boolean;
  /** At |amount|=1: linear → fraction of full range; expOctaves → octaves. */
  modScale: number;
}

export const SYNTH2_DESCRIPTORS: ReadonlyArray<Synth2ParamDescriptor> = [
  // osc1 — spec §5.2. morph: 0 sine → 1 triangle → 2 saw → 3 pulse.
  { key: 'osc1.morph',      min: 0,     max: 3,    default: 2,    taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc1.pulseWidth', min: 0.05,  max: 0.95, default: 0.5,  taper: 'linear',     modulatable: true, modScale: 1 },
  // coarse is semitones (spec §5.2 — wider than synth1's octaves), fine is cents.
  { key: 'osc1.coarse',     min: -36,   max: 36,   default: 0,    taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc1.fine',       min: -100,  max: 100,  default: 0,    taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc1.level',      min: 0,     max: 1,    default: 0.8,  taper: 'linear',     modulatable: true, modScale: 1 },
  // env1 (amp) — same a/d/s/r units as synth1 (seconds / 0..1 sustain).
  { key: 'env1.a',          min: 0.001, max: 10,   default: 0.01, taper: 'expOctaves', modulatable: true, modScale: 4 },
  { key: 'env1.d',          min: 0.001, max: 10,   default: 0.2,  taper: 'expOctaves', modulatable: true, modScale: 4 },
  { key: 'env1.s',          min: 0,     max: 1,    default: 0.5,  taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'env1.r',          min: 0.001, max: 10,   default: 0.5,  taper: 'expOctaves', modulatable: true, modScale: 4 },
  // --- I2b oscillator section (append-only) ---
  // osc2 — mirrors osc1. Default: detuned saw (+7 cents) for the classic fat default (spec §5.8).
  { key: 'osc2.morph',      min: 0,    max: 3,    default: 2,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc2.pulseWidth', min: 0.05, max: 0.95, default: 0.5, taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc2.coarse',     min: -36,  max: 36,   default: 0,   taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc2.fine',       min: -100, max: 100,  default: 7,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc2.level',      min: 0,    max: 1,    default: 0.8, taper: 'linear',     modulatable: true, modScale: 1 },
  // osc3 — mirrors osc1. Default level 0 (silent until dialed in; spec §5.8).
  { key: 'osc3.morph',      min: 0,    max: 3,    default: 2,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc3.pulseWidth', min: 0.05, max: 0.95, default: 0.5, taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc3.coarse',     min: -36,  max: 36,   default: 0,   taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc3.fine',       min: -100, max: 100,  default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc3.level',      min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  // noise — 4th mixer channel. color = one-pole LP openness 0..1: 0 = darkest, 1 = white/unfiltered (spec §6.8).
  { key: 'noise.level',     min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'noise.color',     min: 0,    max: 1,    default: 1,   taper: 'linear',     modulatable: true, modScale: 1 },
  // TZFM index by carrier: fm.osc2 = osc1→osc2, fm.osc3 = osc2→osc3. Range >1 enables
  // through-zero (dt' = dt·(1 + amt·mod) can go negative). Default 0 (off).
  { key: 'fm.osc2',         min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'fm.osc3',         min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
];
