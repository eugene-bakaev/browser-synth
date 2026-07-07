# Envelope A/D/R Tempo-Sync (synth2) — Design

**Date:** 2026-07-06
**Branch:** `feat/env-tempo-sync`
**Status:** Approved (design), pending implementation plan

## Goal

Extend the tempo-sync mechanism shipped for the synth2 LFOs
(spec `2026-07-05-lfo-tempo-sync-design.md`, merged `d8a9e88`) to the three
envelopes: each of env1/env2/env3 gets a per-envelope **SYNC** toggle that
switches its Attack, Decay and Release times from free seconds to musical note
divisions (1/1 … 1/32, straight/dotted/triplet) locked to the project BPM.
Sustain is a level, not a time — untouched. This was the explicitly-deferred
half of the LFO tempo-sync spec.

**Decided during brainstorming:**
- **Granularity: per envelope.** One SYNC button per envelope section; when on,
  that envelope's A, D and R all become division-valued (each keeps its own
  division). Not per-knob (9 buttons of clutter), not D/R-only (asymmetric).
- **Divisions: reuse `LFO_SYNC_DIVISIONS` verbatim.** Same 18 divisions, same
  shared constant, no second list.

## Non-goals

- No tempo-sync for delays or any drum engine.
- No kernel/worklet ABI change beyond appending descriptor rows — the kernel
  stays tempo-agnostic; derived seconds are computed on the main thread.
- No new wire message types; sync rides the existing per-leaf param sync.
- No change to LOOP mode semantics (a looping synced envelope simply cycles
  with tempo-locked A/D times — that falls out for free).
- Not fixing the synth2 old-session sync gap (see Known limitations).

## Data model

Twelve new **append-only** descriptor rows in `SYNTH2_DESCRIPTORS`
(`packages/shared/src/engines/synth2-descriptors.ts`), appended at the **end of
the table (after `lfo2.div`)** because block index = array position. They mirror
the `lfo*.sync` / `lfo*.div` rows exactly (bool + enum-as-label, dead to the
kernel):

| key | kind | min | max | default | modulatable |
|---|---|---|---|---|---|
| `env1.sync` | bool | 0 | 1 | 0 (off) | no |
| `env1.aDiv` | enum (`LFO_SYNC_LABELS`) | 0 | 17 | index of `'1/32'` | no |
| `env1.dDiv` | enum (`LFO_SYNC_LABELS`) | 0 | 17 | index of `'1/8'` | no |
| `env1.rDiv` | enum (`LFO_SYNC_LABELS`) | 0 | 17 | index of `'1/4'` | no |
| `env2.sync` / `env2.aDiv` / `env2.dDiv` / `env2.rDiv` | same | | | same | no |
| `env3.sync` / `env3.aDiv` / `env3.dDiv` / `env3.rDiv` | same | | | same | no |

Row order within the append: `env1.sync, env1.aDiv, env1.dDiv, env1.rDiv,
env2.sync, …, env3.rDiv` (grouped per envelope, sync first).

**Per-stage defaults** roughly match the free-mode defaults at 120 BPM:
`aDiv '1/32'` ≈ 62 ms (free default 10 ms), `dDiv '1/8'` = 250 ms (free 200 ms),
`rDiv '1/4'` = 500 ms (free 0.5 s). Defaults are expressed as
`LFO_SYNC_LABELS.indexOf(...)` — never hardcoded indices.

`Synth2EnvParams` (`packages/shared/src/engines/synth2.ts`) gains:

```ts
sync: boolean;  // tempo-sync on/off (a/d/r derived from div × bpm on the main thread)
aDiv: string;   // note-division labels from LFO_SYNC_DIVISIONS (used when sync is on)
dDiv: string;
rDiv: string;
```

`DEFAULT_SYNTH2_PARAMS` comes from `buildDefaults()` over the descriptor table,
so the new leaves appear in defaults automatically (enum default index decodes
to its label via the existing `decodeEnum`, bool via `decodeBool`).

**Invariant (same as `lfo*.rate`):** the persisted `a`/`d`/`r` leaves are
**never overwritten** by sync. Toggling SYNC off restores exactly the free
values the user last set.

## Shared helper

`packages/shared/src/engines/lfo-sync.ts` (filename kept — it is the divisions'
single home; a rename would churn imports for zero behavior) gains:

```ts
/** Note-division label + BPM → duration in seconds. Unknown label falls back to
 *  the default division, so a corrupt/old value can never yield NaN. */
export function divisionToSeconds(label: string, bpm: number): number {
  const entry = LFO_SYNC_DIVISIONS.find(d => d.label === label)
    ?? LFO_SYNC_DIVISIONS[LFO_SYNC_DEFAULT_INDEX];
  return (60 * entry.beats) / bpm;
}
```

It is the reciprocal of `divisionToHz`; a named helper keeps both call sites
honest. Range check: with BPM clamped to 40–240 (`BPM_MIN`/`BPM_MAX`), derived
times span 20.8 ms (1/32T @ 240) … 9.0 s (1/1. @ 40) — always inside the
envelope param range [0.001, 10] s, so the derivation clamp below is purely
defensive.

## Derivation (main thread; kernel stays tempo-agnostic)

New helper in `packages/client/src/audio/AudioEngine.ts` beside
`effectiveLfoRate`:

```ts
function effectiveEnvTimes(
  env: { sync?: boolean; aDiv?: string; dDiv?: string; rDiv?: string; a: number; d: number; r: number },
  bpm: number,
): { a: number; d: number; r: number } {
  if (!env.sync) return { a: env.a, d: env.d, r: env.r };
  const t = (label: string | undefined) =>
    Math.min(10, Math.max(0.001, divisionToSeconds(label ?? LFO_SYNC_DEFAULT_LABEL, bpm)));
  return { a: t(env.aDiv), d: t(env.dDiv), r: t(env.rDiv) };
}
```

Wired at the same three sites as `effectiveLfoRate`:

1. **Engine build snapshot** (`syncTrackToEngine` synth2 branch, ~line 222):
   spread derived a/d/r into each env object alongside the existing lfo spread.
2. **`engines.env{1,2,3}` leaf-set branch** (~line 308): when a leaf under
   `env1`/`env2`/`env3` changes, re-apply that env with derived times (the same
   pattern the lfo1/lfo2 branch uses).
3. **bpm-change branch** (~line 269–277): currently re-pushes synced LFOs per
   synth2 track; extend it to also re-push each envelope whose `sync` is on.

The kernel receives seconds in the `env*.a/d/r` block slots exactly as today;
the `env*.sync`/`env*.aDiv/dDiv/rDiv` slots exist in the block but are dead to
the kernel (same as `lfo*.sync`/`lfo*.div`). Mid-flight voices are unaffected;
derived values apply from the next note-on, identical to turning an A/D/R knob
today.

## UI (Synth2Panel)

`packages/client/src/components/Synth2Panel.vue`:

- **One SYNC button per envelope section** (env1 "AMP ENV", env2 filter env,
  env3 mod env), placed beside the existing LOOP button. Styled like
  `.lfo-sync-btn` but with its **own class `.env-sync-btn`** so existing
  count-of-2 `.lfo-sync-btn` tests stay green. Click toggles
  `ks.set(['envN', 'sync'], !params.envN.sync)`; `active` class tracks state.
- **Conditional A/D/R knobs**, exactly the LFO Rate pattern:
  - Free (`!params.envN.sync`): today's knobs unchanged
    (`min 0.001, max 10, step 0.001, format="ms", curve="exp"`).
  - Synced: index-valued knob with `:min="0"
    :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS"`,
    `:modelValue="divisionLabelToIndex(params.envN.aDiv)"`, updates via
    `ks.set(['envN', 'aDiv'], LFO_SYNC_LABELS[$event])` (same for dDiv/rDiv;
    `defaultValue` via `divisionLabelToIndex(DEFAULTS.envN.aDiv)`).
- **S and LOOP untouched** in both modes.

## Known limitations

- **synth2 old-session sync gap** ([memory `synth2-old-session-sync-gap`], open
  backlog item): sessions saved before this feature lack the 12 new leaves, so
  edits to them won't sync in those sessions until re-saved. Recurs on every
  descriptor append; the real fix (param-level deep-merge in
  `packages/shared/src/project/normalize.ts` `repairTrack`) is a separate
  backlog item, not part of this spec.
- BPM changes retune synced envelopes from the **next note-on**; a note held
  across a BPM change keeps the stage times it started with (consistent with
  all other param changes).

## Testing

- **Shared:** `divisionToSeconds` unit tests (known values: `'1/4'` @ 120 →
  0.5 s; `'1/1.'` @ 40 → 9 s; unknown label → default division; reciprocal of
  `divisionToHz`). Descriptor-table tests: 12 new rows at the tail in the
  specified order, enum rows carry `LFO_SYNC_LABELS`, defaults decode to
  `'1/32'`/`'1/8'`/`'1/4'`; existing fixture updates.
- **Client (AudioEngine):** sync off → a/d/r pass through untouched; sync on →
  derived from divisions × bpm; bpm change re-pushes synced envs (and only
  synced ones); persisted `a`/`d`/`r` leaves never mutated; defensive clamp.
- **Client (Synth2Panel):** exactly 3 `.env-sync-btn` render (and `.lfo-sync-btn`
  count stays 2); toggling switches A/D/R knobs to label mode ("1/8" readout)
  while S stays a percent knob; div knob updates set the label string.
- **Browser verification (mandatory, `npm run dev:obs`):** read the live worklet
  param block — sync env1 on @ 120 BPM with `dDiv '1/8'` → block `env1.d` slot
  = 0.25 while the store leaf keeps its free value; change BPM 120 → 60 →
  slot = 0.5; sync off → slot returns to the free value; UI shows SYNC button +
  division readouts. Clean console; close the browser session when done.

## Rollout

Same shape as the LFO feature: one branch (`feat/env-tempo-sync`), append-only
descriptor change (old projects load via defaults for missing leaves in new
sessions), no server change, no migration. Render auto-deploys on merge to main.
