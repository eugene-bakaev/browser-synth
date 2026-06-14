// Zod schemas mirroring the Project wire format. These exist so the server can
// validate inbound op values without needing the engine setter clamps (which
// live in DOM-only code), and so we have a runtime check that what we ship
// over the wire matches what TypeScript thinks we ship.
//
// Ranges below mirror the setter clamps in packages/client/src/engine/*Engine.ts
// at the time of writing. Whenever a setter range changes there, the matching
// schema range here must be updated in lockstep — otherwise the server will
// accept ops the client would silently clamp on application, opening a drift.

import { z } from 'zod';
import { TRACK_POOL_SIZE, BPM_MIN, BPM_MAX } from './constants.js';
import { SYNTH2_DESCRIPTORS } from '../engines/synth2-descriptors.js';

// --- Primitives -----------------------------------------------------------

const OscillatorTypeSchema = z.union([
  z.literal('sine'),
  z.literal('square'),
  z.literal('sawtooth'),
  z.literal('triangle'),
]);

// ADSR fields are `a/d/s/r` (NOT attack/decay/sustain/release). The engine
// clamps a/d/r to a lower bound of 0.001 with no upper bound; we pick 10s as
// a sensible cap for the wire (anything past that is musically pathological
// and almost certainly a fuzzed input). `s` is sustain level, [0, 1].
const ADSRSchema = z.object({
  a: z.number().min(0.001).max(10),
  d: z.number().min(0.001).max(10),
  s: z.number().min(0).max(1),
  r: z.number().min(0.001).max(10),
});

// --- Engine params --------------------------------------------------------

const SynthParamsSchema = z.object({
  osc1Type: OscillatorTypeSchema,
  osc2Type: OscillatorTypeSchema,
  // SynthEngine.ts:83,93 — clamp [-3, 3]. Stored as a number; not enforced
  // to integer in the engine, so we don't enforce it here either.
  osc1Coarse: z.number().min(-3).max(3),
  osc2Coarse: z.number().min(-3).max(3),
  osc1Fine: z.number().min(-100).max(100),
  osc2Fine: z.number().min(-100).max(100),
  osc1Level: z.number().min(0).max(1),
  osc2Level: z.number().min(0).max(1),
  osc1PulseWidth: z.number().min(0.05).max(0.95),
  osc2PulseWidth: z.number().min(0.05).max(0.95),
  filterCutoff: z.number().min(20).max(20000),
  // Setter name (and field name in SynthEngineParams) is `filterRes`, not
  // `filterResonance`. Clamp [0, 20].
  filterRes: z.number().min(0).max(20),
  // FILTER_ENV_MAX_OCTAVES = 4 (SynthVoice.ts), bipolar.
  filterEnvAmount: z.number().min(-4).max(4),
  filterEnv: ADSRSchema,
  ampEnv: ADSRSchema,
  mode: z.union([z.literal('mono'), z.literal('poly')]),
});

const KickParamsSchema = z.object({
  tune: z.number().min(40).max(120),
  decay: z.number().min(0.05).max(1.5),
  click: z.number().min(0).max(1),
});

const HatParamsSchema = z.object({
  decay: z.number().min(0.02).max(0.6),
  tone: z.number().min(3000).max(14000),
  metallic: z.number().min(0).max(1),
});

const SnareParamsSchema = z.object({
  tune: z.number().min(100).max(250),
  decay: z.number().min(0.05).max(0.8),
  snappy: z.number().min(0).max(1),
});

const ClapParamsSchema = z.object({
  decay: z.number().min(0.05).max(0.8),
  tone: z.number().min(500).max(3000),
  sloppy: z.number().min(0.005).max(0.03),
});

// --- synth2: GENERATED from the descriptor table (spec §6.4) ---------------
// One leaf schema per descriptor: `z.number().min().max()` for continuous rows,
// `z.boolean()` for `kind:'bool'`, `z.enum(values)` for `kind:'enum'` — grouped
// into nested module objects ('osc1.morph' ⇒ { osc1: { morph } }).
// schema.test.ts asserts the derivation, so the table cannot drift from the wire
// validation.

const synth2LeafEntries = SYNTH2_DESCRIPTORS.map(
  d => [
    d.key,
    d.kind === 'bool' ? z.boolean()
      : d.kind === 'enum' ? z.enum(d.enumValues as unknown as [string, ...string[]])
      : z.number().min(d.min).max(d.max),
  ] as const,
);

export const SYNTH2_LEAF_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> =
  Object.fromEntries(synth2LeafEntries);

const synth2Modules: Record<string, Record<string, z.ZodTypeAny>> = {};
for (const [key, schema] of synth2LeafEntries) {
  const [mod, field] = key.split('.');
  (synth2Modules[mod] ??= {})[field] = schema;
}

const Synth2ParamsSchema = z.object({
  ...Object.fromEntries(
    Object.entries(synth2Modules).map(([mod, fields]) => [mod, z.object(fields).strict()]),
  ),
  mode: z.union([z.literal('mono'), z.literal('poly')]),
});

// --- Step / Track / Project ----------------------------------------------

const StepSchema = z.object({
  // `null` means "rest" — must be nullable on the wire.
  note: z.string().nullable(),
  octave: z.number().int().min(0).max(8),
  length: z.number().int().min(1).max(16),
  velocity: z.number().min(0).max(1),
  // Actual field name is `muted` (not `mute`).
  muted: z.boolean(),
  // `isChord` and `chordType` are optional on the type — leave them optional
  // here so freshStep() (which includes them) and a step that omits them both
  // parse.
  isChord: z.boolean().optional(),
  chordType: z.string().optional(),
});

const MixerSchema = z.object({
  // MixerState.volume is a slider in [0, 1]; log mapping is the consumer's job.
  volume: z.number().min(0).max(1),
  muted: z.boolean(),
  soloed: z.boolean(),
});

const EngineTypeSchema = z.union([
  z.literal('synth'),
  z.literal('kick'),
  z.literal('hat'),
  z.literal('snare'),
  z.literal('clap'),
  z.literal('synth2'),
]);

const EnginesMapSchema = z.object({
  synth: SynthParamsSchema,
  kick: KickParamsSchema,
  hat: HatParamsSchema,
  snare: SnareParamsSchema,
  clap: ClapParamsSchema,
  synth2: Synth2ParamsSchema,
});

const TrackSchema = z.object({
  engineType: EngineTypeSchema,
  engines: EnginesMapSchema,
  mixer: MixerSchema,
  // Track loop-window length (steps). The buffer below is fixed at 64.
  patternLength: z.number().int().min(1).max(64),
  steps: z.array(StepSchema).length(64),
  // Whether this pool slot is an active track. Always present post-normalization.
  enabled: z.boolean(),
});

export const ProjectSchema = z.object({
  schemaVersion: z.literal(2),
  // No engine-level BPM clamp; pick a generous-but-sane range. The sequencer
  // schedules off this directly, so we keep it as an integer. Range constants
  // are single-sourced in constants.ts (shared with coerceBpm + the factory).
  bpm: z.number().int().min(BPM_MIN).max(BPM_MAX),
  tracks: z.array(TrackSchema).length(TRACK_POOL_SIZE),
});

// Re-exported lookup map. The accept-list path walker uses these to validate
// the leaf value at a writable path. Every leaf schema referenced by a path
// pattern in accept-list.ts MUST exist here.
export const Schemas = {
  Project: ProjectSchema,
  Track: TrackSchema,
  Step: StepSchema,
  Mixer: MixerSchema,
  EngineType: EngineTypeSchema,
  EnginesMap: EnginesMapSchema,
  SynthParams: SynthParamsSchema,
  Synth2Params: Synth2ParamsSchema,
  KickParams: KickParamsSchema,
  HatParams: HatParamsSchema,
  SnareParams: SnareParamsSchema,
  ClapParams: ClapParamsSchema,
  ADSR: ADSRSchema,
  OscillatorType: OscillatorTypeSchema,
} as const;
