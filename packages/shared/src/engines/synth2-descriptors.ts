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

// Discrete kinds ride the SAME Float32Array param block as continuous params
// (spec §6.6: "enums and booleans encoded as floats") but are applied at block
// boundaries WITHOUT a smoother and are excluded from the mod matrix. I2c-1
// adds only 'bool' (osc hard-sync toggles); 'enum' (filter model/type) lands in
// I2c-2 — widen this union then.
export type Synth2Kind = 'continuous' | 'bool';

export interface Synth2ParamDescriptor {
  /** '<module>.<field>' — also the wire-path tail under engines.synth2 */
  key: string;
  min: number;
  max: number;
  /** Continuous: the value. bool: 0 = false, 1 = true. */
  default: number;
  /** How modulation is applied in the kernel (spec §6.3). Base values are linear. */
  taper: Synth2Taper;
  /** Whether the mod matrix (I3) may target this slot. Discrete rows: false. */
  modulatable: boolean;
  /** At |amount|=1: linear → fraction of full range; expOctaves → octaves. */
  modScale: number;
  /** Discrete kinds skip the smoother and the mod matrix. Omitted ⇒ 'continuous'. */
  kind?: Synth2Kind;
}

/** A param is discrete (block-boundary, no smoother, not a mod dest) when it
 *  declares a non-continuous kind. Continuous rows omit `kind`. */
export const isDiscrete = (d: Synth2ParamDescriptor): boolean =>
  d.kind !== undefined && d.kind !== 'continuous';

/** Bool ⇄ float-block encoding (spec §6.6). Threshold at 0.5 on decode so a
 *  float32-roundtripped 1 still reads true. */
export const encodeBool = (v: boolean): number => (v ? 1 : 0);
export const decodeBool = (n: number): boolean => n >= 0.5;

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
  // --- I2c-1 hard sync (append-only). Discrete booleans: ride the block as 0/1,
  // applied at the block boundary (no smoother), excluded from the mod matrix.
  // osc1.sync is inert (osc1 is the sync master) but kept so all 3 oscs share
  // one uniform param shape (spec §7.2). Kernel wires osc2←osc1, osc3←osc2.
  // modScale is 0 because discrete rows are never mod-matrix destinations.
  { key: 'osc1.sync',       min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'osc2.sync',       min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'osc3.sync',       min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: false, modScale: 0, kind: 'bool' },
];
