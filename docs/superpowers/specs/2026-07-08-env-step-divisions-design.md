# Envelope A/D/R Step-Fraction Divisions (synth2) — Design

**Date:** 2026-07-08
**Branch:** `feat/env-step-divisions`
**Status:** Approved (design), pending implementation plan

## Goal

Replace the note-division vocabulary used by synth2 envelope A/D/R tempo-sync
(spec `2026-07-06-env-tempo-sync-design.md`, merged `532b46f`) with a
**step-fraction** vocabulary: stage lengths are expressed as fractions or
multiples of one sequencer step instead of note divisions. One step is a fixed
1/16 note (`tickDuration = (60/bpm)/4`, AudioEngine), so this is a relabeling
of the time axis — but the new set is designed around the step, giving **9
options at or under one step** (down to 1/16 step ≈ 7.8 ms @ 120 BPM) versus
the 4 the note-division table offered. The motivating use case: shaping a full
A+D+R envelope inside a single step.

**Decided during brainstorming:**
- **Scope: envelopes only.** LFO tempo-sync keeps `LFO_SYNC_DIVISIONS`
  (note divisions) untouched — code, descriptors, persisted labels, UI.
- **No legacy shim.** Envelope div labels saved during the two-day window
  since the env-sync merge are not translated. Consequences are bounded and
  accepted (see Known limitations).

## Non-goals

- No change to LFO sync (list, labels, `divisionToHz`, UI).
- No change to the SYNC toggle mechanics, derivation sites, or the
  "persisted `a`/`d`/`r` leaves are never overwritten" invariant.
- No kernel/worklet change of any kind; the div slots stay dead to the kernel.
- No descriptor rows added or removed — **row count and block layout are
  unchanged** (no new old-session sync gap).
- No legacy-label translation layer.

## Data model

New shared module `packages/shared/src/engines/env-sync.ts`, the single home
of the envelope division vocabulary:

```ts
export interface EnvSyncDivision {
  /** Display label, also the persisted enum value (e.g. "1/2", "1.5", "16"). */
  readonly label: string;
  /** Length in sequencer steps; one step = a 1/16 note = (60/bpm)/4 seconds. */
  readonly steps: number;
}

// Ordered slowest → fastest so the knob sweeps left(slow)→right(fast),
// matching the free-mode seconds knob and the LFO sync knob.
export const ENV_SYNC_DIVISIONS: readonly EnvSyncDivision[] = [
  { label: '32',   steps: 32 },
  { label: '24',   steps: 24 },
  { label: '16',   steps: 16 },
  { label: '12',   steps: 12 },
  { label: '8',    steps: 8 },
  { label: '6',    steps: 6 },
  { label: '4',    steps: 4 },
  { label: '3',    steps: 3 },
  { label: '2',    steps: 2 },
  { label: '1.5',  steps: 1.5 },
  { label: '1',    steps: 1 },
  { label: '3/4',  steps: 3 / 4 },
  { label: '2/3',  steps: 2 / 3 },
  { label: '1/2',  steps: 1 / 2 },
  { label: '1/3',  steps: 1 / 3 },
  { label: '1/4',  steps: 1 / 4 },
  { label: '1/6',  steps: 1 / 6 },
  { label: '1/8',  steps: 1 / 8 },
  { label: '1/16', steps: 1 / 16 },
];

export const ENV_SYNC_LABELS: readonly string[] = ENV_SYNC_DIVISIONS.map(d => d.label);
export const ENV_SYNC_DEFAULT_LABEL = '1';
export const ENV_SYNC_DEFAULT_INDEX = ENV_SYNC_LABELS.indexOf(ENV_SYNC_DEFAULT_LABEL);

/** Step-division label + BPM → duration in seconds (steps × one step's length).
 *  Unknown label falls back to the default division, so a corrupt/legacy value
 *  can never yield NaN. */
export function envDivisionToSeconds(label: string, bpm: number): number {
  const entry = ENV_SYNC_DIVISIONS.find(d => d.label === label)
    ?? ENV_SYNC_DIVISIONS[ENV_SYNC_DEFAULT_INDEX];
  return (entry.steps * 15) / bpm; // steps × (60/bpm)/4
}

/** Division label → its index; unknown label → the default index. */
export function envDivisionLabelToIndex(label: string): number {
  const i = ENV_SYNC_LABELS.indexOf(label);
  return i < 0 ? ENV_SYNC_DEFAULT_INDEX : i;
}
```

`divisionToSeconds` is **deleted** from `lfo-sync.ts` (its only consumer was
the envelope derivation); `envDivisionToSeconds` replaces it. The rename makes
the semantic change (note beats → steps) explicit and lets the compiler catch
any stale call site. `lfo-sync.ts` keeps everything else unchanged. Both
modules re-export through the shared index as today.

**Per-stage defaults** map exactly onto the old ones (same durations):

| stage | old (note) | new (steps) | @ 120 BPM |
|---|---|---|---|
| aDiv | `'1/32'` | `'1/2'` | 62.5 ms |
| dDiv | `'1/8'` | `'2'` | 250 ms |
| rDiv | `'1/4'` | `'4'` | 500 ms |

Reference durations @ 120 BPM (step = 125 ms): `1/16` 7.8 ms, `1/8` 15.6 ms,
`1/6` 20.8 ms, `1/4` 31.2 ms, `1/3` 41.7 ms, `1/2` 62.5 ms, `2/3` 83.3 ms,
`3/4` 93.75 ms, `1` 125 ms, `1.5` 187.5 ms, `2` 250 ms … `16` 2 s (one bar),
`32` 4 s.

## Descriptor table (in-place enum swap, NOT an append)

The 9 existing `env{1,2,3}.aDiv/dDiv/rDiv` rows in
`packages/shared/src/engines/synth2-descriptors.ts` change **in place**:

- `enumValues: LFO_SYNC_LABELS` → `enumValues: ENV_SYNC_LABELS`
- `max: LFO_SYNC_LABELS.length - 1` → `max: ENV_SYNC_LABELS.length - 1` (18)
- defaults → `ENV_SYNC_LABELS.indexOf('1/2' | '2' | '4')` (never hardcoded
  indices)

**Why this does not violate append-only:** append-only protects the block
index = array position ABI. Row count and positions are unchanged. The enum
*index encoding* inside a row's block slot changes meaning, but (a) these
slots are dead to the kernel, (b) block encodings are derived at runtime from
the persisted label, never persisted, and (c) wire ops carry labels, not
indices. The `env*.sync` bool rows are untouched.

`Synth2EnvParams` in `synth2.ts` is shape-unchanged (`aDiv/dDiv/rDiv` remain
strings); only the doc comments update to say "step-division labels from
ENV_SYNC_DIVISIONS". `buildDefaults()` picks up the new defaults automatically.

## Derivation (AudioEngine)

`effectiveEnvTimes` in `packages/client/src/audio/AudioEngine.ts` changes only
its lookup: `divisionToSeconds` → `envDivisionToSeconds`, and the
`?? LFO_SYNC_DEFAULT_LABEL` fallbacks → `?? ENV_SYNC_DEFAULT_LABEL`. The three
wiring sites (build snapshot, bpm branch, env leaf intercept), the
never-overwrite-leaves invariant, and the defensive clamp `[0.001, 10]` are
untouched. Range note: `1/16` step @ 40 BPM = 23.4 ms, `32` steps @ 40 BPM =
12 s → clamped to 10 s (the clamp is now load-bearing at the slow extreme,
not merely defensive — a test covers it).

## UI (Synth2Panel)

The 9 synced A/D/R knobs in `packages/client/src/components/Synth2Panel.vue`
switch from `LFO_SYNC_LABELS`/`divisionLabelToIndex` to
`ENV_SYNC_LABELS`/`envDivisionLabelToIndex` (labels prop, min/max, modelValue,
defaultValue, update handler). The two LFO Rate sync knobs keep the LFO
vocabulary. No layout, button, or CSS changes; SYNC/LOOP/S untouched.

## Known limitations (accepted, no-shim decision)

Envelope div labels persisted during 2026-07-06 → 2026-07-08 use the note
vocabulary. After this change:

- **In-DB sessions load fine.** Snapshot loading normalizes presence-only
  (`isComplete` checks keys, not values), so legacy labels ride through;
  every runtime consumer falls back gracefully: `envDivisionToSeconds` →
  default division (1 step), knob index → default position, block enum
  encode → dead slot. Four colliding labels (`1/2`, `1/4`, `1/8`, `1/16`)
  reinterpret as step fractions (16× shorter); the rest fall back to 1 step.
  Touching the knob writes a valid new label.
- **Bulk-load import of window-era exports is nacked.** The `load` message
  validates with strict `Schemas.Project` (ConnectionHandler.ts), so a project
  *file* exported during the window fails import with `value.invalid` on the
  first legacy div leaf. Recovery: edit the JSON labels by hand, or discard —
  the window only contains this project's own test experiments. Accepted as
  part of the no-shim decision; a permanent leniency carve-out for 9 leaves
  is not worth it.
- **Preset-apply of window-era synth2 presets partially nacks online.**
  `applyPreset` dispatches per-leaf ops; the server accept-list validates each
  against the new enum, so the 9 legacy div leaves get `value.invalid` nacks
  and roll back while the rest of the preset applies. Same population as the
  bullet above (this project's own window-era test experiments); accepted.
- The synth2 old-session sync gap does **not** grow: no rows are added.

## Testing

- **Shared (`env-sync.test.ts`):** `envDivisionToSeconds` known values
  (`'1'` @ 120 → 0.125 s; `'4'` @ 120 → 0.5 s; `'1/16'` @ 120 → 0.0078125 s;
  `'32'` @ 40 → 12 s pre-clamp; unknown label → 1 step); labels array derived
  from the table; `envDivisionLabelToIndex` fallback. `lfo-sync.test.ts`
  drops the `divisionToSeconds` cases (function deleted); everything else
  stays.
- **Shared (descriptors):** the 9 div rows carry `ENV_SYNC_LABELS`, max 18,
  defaults decode to `'1/2'`/`'2'`/`'4'`; `env*.sync` rows unchanged; row
  count and tail order unchanged.
- **Client (AudioEngine):** synced env derives step-based times
  (defaults @ 120 → a 0.0625, d 0.25, r 0.5); `'32'` @ 40 clamps to 10;
  unknown label falls back to 1 step; leaves never mutated; bpm re-push
  unchanged. Existing fixtures rewritten from note labels to step labels.
- **Client (Synth2Panel):** synced knob readout shows step labels ("1/2");
  div knob updates persist step labels; LFO Rate knob still shows note labels
  ("1/16") — guards the two vocabularies staying separate.
- **Fixtures:** schema/reconcile fixtures carrying old div labels or defaults
  update to the new defaults.
- **Browser verification (mandatory, `npm run dev:obs`):** sync env1 on
  @ 120 BPM → block a/d/r = 0.0625/0.25/0.5 (same durations as before, now
  from step labels) while store leaves keep free values; pick `'1/8'` for
  aDiv → block a = 0.015625; BPM 120 → 60 doubles derived times; sync off
  restores free values; UI shows step labels on A/D/R and note labels on LFO
  Rate. Clean console; close the browser session when done.

## Amendments (2026-07-09, user feedback)

- **Table order REVERSED to shortest → longest** (`1/16` first, `32` last;
  default `'1'` now index 8). The original slowest-first order copied the LFO
  table, but that ordering is only right for a RATE knob (right = faster =
  matches free-mode Hz). Env A/D/R are TIME knobs: right must = longer to
  match the free-mode seconds knobs they replace. Safe reorder: persisted
  values are label strings, defaults use `indexOf`, block enum encodings are
  runtime-derived and dead to the kernel.
- **Knob readout gains a unit**: new display-only `ENV_SYNC_KNOB_LABELS`
  (`"2 st"`, `"1/2 st"`) used for the panel `:labels`; persisted enum values
  and wire ops remain the bare `ENV_SYNC_LABELS` strings.

## Rollout

One branch (`feat/env-step-divisions`), shared + client change only, no server
change, no migration, no new descriptor rows. Render auto-deploys on merge to
main.
