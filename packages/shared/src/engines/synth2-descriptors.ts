//
// THE single source of truth for synth2 parameters (spec §6.4). Everything
// else derives from this table: the Zod schema + leaf validators (schema.ts),
// the accept-list patterns (accept-list.ts), DEFAULT_SYNTH2_PARAMS (synth2.ts),
// the kernel's Float32Array param-block layout (client kernel/params.ts), and
// panel knob ranges. Contract tests in each consumer assert the derivation.
//
// APPEND-ONLY once I1 merges: the param block index is the array position, so
// inserting/reordering would silently scramble every older client's params.

import type { KnobCurve } from './knob-curve.js';
import { LFO_SYNC_LABELS, LFO_SYNC_DEFAULT_INDEX } from './lfo-sync.js';

export type Synth2Taper = 'linear' | 'expOctaves';

// Discrete kinds ride the SAME Float32Array param block as continuous params
// (spec §6.6: "enums and booleans encoded as floats") but are applied at block
// boundaries WITHOUT a smoother and are excluded from the mod matrix.
//   'bool' — I2c-1 osc hard-sync toggles (encoded 0/1).
//   'enum' — I2c-2 filter.type (encoded as the value's index; see enumValues).
export type Synth2Kind = 'continuous' | 'bool' | 'enum';

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
  /** For kind:'enum' only — the ordered value set; the block stores the index. */
  enumValues?: readonly string[];
  /** Optional UI knob response curve (presentational only). Omitted ⇒ 'linear'.
   *  Distinct from `taper`, which scales kernel modulation, not the UI. */
  curve?: KnobCurve;
}

/** A param is discrete (block-boundary, no smoother, not a mod dest) when it
 *  declares a non-continuous kind. Continuous rows omit `kind`. */
export const isDiscrete = (d: Synth2ParamDescriptor): boolean =>
  d.kind !== undefined && d.kind !== 'continuous';

/** Bool ⇄ float-block encoding (spec §6.6). Threshold at 0.5 on decode so a
 *  float32-roundtripped 1 still reads true. */
export const encodeBool = (v: boolean): number => (v ? 1 : 0);
export const decodeBool = (n: number): boolean => n >= 0.5;

/** Enum ⇄ float-block encoding (spec §6.6): the block stores the value's index.
 *  Unknown value → 0 (first), so a corrupt/old wire value degrades to the default. */
export const encodeEnum = (value: string, values: readonly string[]): number => {
  const i = values.indexOf(value);
  return i < 0 ? 0 : i;
};
export const decodeEnum = (n: number, values: readonly string[]): string => {
  const i = Math.round(n);
  return values[i < 0 ? 0 : i >= values.length ? values.length - 1 : i] ?? values[0];
};

export const SYNTH2_DESCRIPTORS: ReadonlyArray<Synth2ParamDescriptor> = [
  // osc1 — spec §5.2. morph: 0 sine → 1 triangle → 2 saw → 3 pulse.
  { key: 'osc1.morph',      min: 0,     max: 3,    default: 2,    taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc1.pulseWidth', min: 0.05,  max: 0.95, default: 0.5,  taper: 'linear',     modulatable: true, modScale: 1 },
  // coarse is semitones (spec §5.2 — wider than synth1's octaves), fine is cents.
  { key: 'osc1.coarse',     min: -36,   max: 36,   default: 0,    taper: 'linear',     modulatable: true, modScale: 24 / 72 },
  { key: 'osc1.fine',       min: -100,  max: 100,  default: 0,    taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'osc1.level',      min: 0,     max: 1,    default: 0.8,  taper: 'linear',     modulatable: true, modScale: 1 },
  // env1 (amp) — same a/d/s/r units as synth1 (seconds / 0..1 sustain).
  { key: 'env1.a',          min: 0.001, max: 10,   default: 0.01, taper: 'expOctaves', modulatable: true, modScale: 4, curve: 'exp' },
  { key: 'env1.d',          min: 0.001, max: 10,   default: 0.2,  taper: 'expOctaves', modulatable: true, modScale: 4, curve: 'exp' },
  { key: 'env1.s',          min: 0,     max: 1,    default: 0.5,  taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'env1.r',          min: 0.001, max: 10,   default: 0.5,  taper: 'expOctaves', modulatable: true, modScale: 4, curve: 'exp' },
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
  // noise — 4th mixer channel. color morphs five textbook noise colors, white at
  // center (spec 2026-06-20): 0 brown(-6 dB/oct) · 0.25 pink(-3) · 0.5 white(0) ·
  // 0.75 blue(+3) · 1 violet(+6). Loudness-matched so the knob is purely tonal.
  { key: 'noise.level',     min: 0,    max: 1,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'noise.color',     min: 0,    max: 1,    default: 0.5, taper: 'linear',     modulatable: true, modScale: 1 },
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
  // --- I2c-2 filter section (append-only). env2 mirrors env1 (a/d/r expOctaves
  // time taper, s linear). filter cutoff is expOctaves (±4 oct mod range);
  // resonance/keyTrack linear. filter.envAmount is the HARDWIRED env2→cutoff
  // depth in bipolar octaves (±4): continuous (smoothed) but NOT a mod dest
  // (spec §5.6 omits it), so modulatable:false. filter.type is the first ENUM —
  // rides the block as an index (lp=0,bp=1,hp=2), applied at the block boundary.
  { key: 'env2.a',          min: 0.001, max: 10,    default: 0.01, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
  { key: 'env2.d',          min: 0.001, max: 10,    default: 0.2,  taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
  { key: 'env2.s',          min: 0,     max: 1,     default: 0.5,  taper: 'linear',     modulatable: true,  modScale: 1 },
  { key: 'env2.r',          min: 0.001, max: 10,    default: 0.5,  taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
  { key: 'filter.cutoff',   min: 20,    max: 20000, default: 2000, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
  { key: 'filter.resonance',min: 0,     max: 1,     default: 0.15, taper: 'linear',     modulatable: true,  modScale: 1, curve: 's' },
  { key: 'filter.keyTrack', min: 0,     max: 1,     default: 0,    taper: 'linear',     modulatable: true,  modScale: 1 },
  { key: 'filter.envAmount',min: -4,    max: 4,     default: 2.4,  taper: 'linear',     modulatable: false, modScale: 0 },
  { key: 'filter.type',     min: 0,     max: 2,     default: 0,    taper: 'linear',     modulatable: false, modScale: 0, kind: 'enum', enumValues: ['lp', 'bp', 'hp'] },
  // --- I3b LFOs (append-only). Two per-voice retriggered LFOs filling the
  // inert lfo1/lfo2 mod sources. rate as a mod DEST is exponential ±4 oct (like
  // filter.cutoff); its base value is plain Hz (log response is a panel-knob
  // mapping). shape is a continuous 0..4 morph (sine→tri→saw-up→saw-down→square),
  // linear/full-range like osc morph. Both modulatable so the matrix can sweep
  // them (incl. LFO→LFO). MOD_SOURCES is unchanged — lfo1/lfo2 already exist there.
  { key: 'lfo1.rate',  min: 0.01, max: 2000, default: 5,   taper: 'expOctaves', modulatable: true, modScale: 4, curve: 'exp' },
  { key: 'lfo1.shape', min: 0,    max: 4,    default: 0,   taper: 'linear',     modulatable: true, modScale: 1 },
  { key: 'lfo2.rate',  min: 0.01, max: 2000, default: 0.5, taper: 'expOctaves', modulatable: true, modScale: 4, curve: 'exp' },
  { key: 'lfo2.shape', min: 0,    max: 4,    default: 1,   taper: 'linear',     modulatable: true, modScale: 1 },
  // --- I3c env3 + loop mode (append-only). env3 mirrors env1/env2 (a/d/r
  // expOctaves time taper, s linear) but is NOT hardwired to anything — it
  // exists solely as the env3 mod source (live as of I3c). The three loop rows
  // mirror the sync toggles: kind:'bool', applied at the block boundary, NOT
  // mod-matrix destinations (modulatable:false). Default off ⇒ behavior unchanged.
  { key: 'env3.a',    min: 0.001, max: 10, default: 0.2, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
  { key: 'env3.d',    min: 0.001, max: 10, default: 0.3, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
  { key: 'env3.s',    min: 0,     max: 1,  default: 0,   taper: 'linear',     modulatable: true,  modScale: 1 },
  { key: 'env3.r',    min: 0.001, max: 10, default: 0.3, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp' },
  { key: 'env1.loop', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env2.loop', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env3.loop', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  // --- I3d morph filter (append-only). filter.morph is the continuous LP→BP→HP
  // blend (0..2), modulatable so the matrix can sweep the filter ARCHITECTURE
  // (auto-joins MOD_DESTS). filter.model selects the FilterModule per track — the
  // 2nd enum after filter.type, riding the block as an index (classic=0, morph=1),
  // applied at the block boundary, NOT a mod dest (modulatable:false).
  { key: 'filter.morph', min: 0, max: 2, default: 0, taper: 'linear', modulatable: true,  modScale: 1 },
  { key: 'filter.model', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ['classic', 'morph'] },
  // --- filter self-oscillation (2026-06-20, append-only). filter.drive is the
  // opt-in feedback-saturation amount (0 = clean = today). Continuous + modulatable
  // (auto-joins MOD_DESTS) so an LFO/env can sweep it. The self-oscillation itself
  // lives at the top of filter.resonance (>0.9), needing no new param.
  { key: 'filter.drive', min: 0, max: 1, default: 0, taper: 'linear', modulatable: true,  modScale: 1 },
  // --- LFO tempo-sync (2026-07-05, append-only). Opt-in per LFO. When sync is
  // on, the effective rate is derived on the MAIN THREAD (AudioEngine) from the
  // note division × project bpm and written into lfoN.rate before it reaches the
  // kernel — the kernel never reads these two rows, so they are dead block slots
  // kept only so the leaves auto-derive (schema / accept-list / defaults). Not
  // mod dests (modulatable:false, modScale:0), like osc sync bools / filter enums.
  { key: 'lfo1.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'lfo1.div',  min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_DEFAULT_INDEX, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'lfo2.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'lfo2.div',  min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_DEFAULT_INDEX, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  // --- Envelope tempo-sync (2026-07-06, append-only). Opt-in per ENVELOPE:
  // one sync toggle switches that envelope's A/D/R to note divisions (each
  // stage keeps its own division). Derived SECONDS are computed on the MAIN
  // THREAD (AudioEngine, divisionToSeconds) and written into env*.a/d/r before
  // reaching the kernel — these 12 rows are dead block slots exactly like
  // lfo*.sync/div, kept so the leaves auto-derive (schema/accept-list/defaults).
  // Per-stage defaults ≈ the free-mode defaults at 120 BPM (62ms/250ms/500ms).
  { key: 'env1.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env1.aDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/32'), taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env1.dDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/8'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env1.rDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/4'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env2.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env2.aDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/32'), taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env2.dDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/8'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env2.rDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/4'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env3.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env3.aDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/32'), taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env3.dDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/8'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env3.rDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/4'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
];

/** key → enum value set, for the descriptors that declare one. Engine + kernel
 *  use this to encode/decode enum leaves without re-walking the table. */
export const SYNTH2_ENUM_VALUES: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    SYNTH2_DESCRIPTORS.filter(d => d.kind === 'enum' && d.enumValues).map(d => [d.key, d.enumValues!]),
  );

// --- I3 modulation matrix (spec §5.6) -------------------------------------
// Source enum: ORDER IS THE WIRE ENCODING for matrix[*].source and the index
// into the kernel's per-sample sources[] array. Append-only. lfo1/lfo2 went
// live in I3b; env3 went live in I3c. All listed sources now produce real values.
export const MOD_SOURCES = [
  'none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise',
] as const;
export type Synth2ModSource = typeof MOD_SOURCES[number];

// Destination enum: 'none' plus every CONTINUOUS, modulatable descriptor key,
// in descriptor order. Derived (not hand-listed) so it can't drift from the
// table. The kernel encodes a dest as PARAM_INDEX+1 (0 = none); this string
// list is the persisted/validation form. A dest is therefore append-stable for
// the same reason the descriptor block is.
export const MOD_DESTS: readonly string[] = [
  'none', ...SYNTH2_DESCRIPTORS.filter(d => d.modulatable).map(d => d.key),
];
export type Synth2ModDest = string; // 'none' | <modulatable descriptor key>
