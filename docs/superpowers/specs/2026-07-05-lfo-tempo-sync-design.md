# LFO Tempo-Sync + Sub-Hz Rate Display (synth2) — Design

**Date:** 2026-07-05
**Branch:** `feat/lfo-tempo-sync`
**Status:** Approved (design), pending implementation plan

## Goal

Two related improvements to the synth2 LFO Rate control:

- **Part A (idea #2):** Fix the sub-1 Hz "dead zone" — the Rate knob already has fine
  sub-Hz resolution, but its readout rounds to whole Hz so everything below 0.5 Hz
  shows "0Hz" and looks broken. Purely presentational.
- **Part B (idea #1):** Add an optional **tempo-synced** mode to each LFO, where the
  rate is expressed as a musical note division (1/1 … 1/32, straight/dotted/triplet)
  locked to the project BPM, instead of free-running Hz.

Envelopes (env1/2/3 A/D/R) are explicitly **out of scope** for this iteration but the
mechanism is designed so they can adopt the same sync approach later.

## Non-goals

- No tempo-sync for envelopes, delays, or any drum engine.
- No change to the kernel/worklet ABI beyond appending descriptor rows (the kernel
  stays tempo-agnostic; the derived Hz is computed on the main thread).
- No new wire message types; sync rides the existing per-leaf param sync.

---

## Part A — Sub-1 Hz rate display

**Root cause.** `packages/client/src/components/Knob.vue`'s `hz` formatter does
`Math.round(val) + 'Hz'`, collapsing every value below 0.5 Hz to `"0Hz"` and 0.5–1.5 Hz
to `"1Hz"`. The underlying value is fine — the LFO Rate knob is `min 0.01, max 2000,
step 0.01, curve exp`, so roughly the bottom ~38% of dial travel is sub-1 Hz with
smooth resolution. Only the label lies.

**Change.** In the `hz` formatter, when `val < 10` render with decimals; otherwise
unchanged:

- `val < 10` → up to 2 decimals, trailing zeros trimmed (`0.25Hz`, `2.5Hz`, `9.99Hz`).
- `10 ≤ val < 1000` → `Math.round(val) + 'Hz'` (unchanged: `440Hz`).
- `val ≥ 1000` → `(val / 1000).toFixed(1) + 'k'` (unchanged: `2.0k`).

**Blast radius.** The only other `hz` knob is `filter.cutoff` (`min 20`), which never
reaches the `< 10` branch, so no other knob visibly changes. No ABI/sync/kernel impact.

---

## Part B — LFO tempo-sync

### Data model

Four new **append-only** descriptor rows in `SYNTH2_DESCRIPTORS`
(`packages/shared/src/engines/synth2-descriptors.ts`). Because the descriptor block
index is the array position, these rows are appended at the **end of the table (after
`filter.drive`)**, even though their keys are `lfo1.*` / `lfo2.*`. They mirror the
existing discrete rows (`osc*.sync` bools, `filter.type`/`filter.model` enums):

| key | kind | min | max | default | modulatable | modScale |
|---|---|---|---|---|---|---|
| `lfo1.sync` | bool | 0 | 1 | 0 (off) | false | 0 |
| `lfo1.div`  | enum | 0 | 17 | `1/16` | false | 0 |
| `lfo2.sync` | bool | 0 | 1 | 0 (off) | false | 0 |
| `lfo2.div`  | enum | 0 | 17 | `1/16` | false | 0 |

- `lfo*.div` declares `enumValues` = the 18 division labels (see below). Per the existing
  enum convention (confirmed against `filter.type`), the **persisted/synced leaf is the
  label string** (e.g. `"1/16"`); the numeric index only exists in the kernel's
  Float32Array block via `encodeEnum`/`decodeEnum`.
- `lfo*.rate` (the existing Hz leaf) is **unchanged**. It remains the free-mode value
  and the restore target when SYNC is toggled off.
- All auto-derivation stays intact: the Zod schema, accept-list patterns,
  `DEFAULT_SYNTH2_PARAMS`, and the nested params object
  (`engines.synth2.lfo1.{rate,shape,sync,div}`) all derive from the descriptor table by
  splitting the key on `.`. No consumer needs manual edits beyond the table.
- `default off` ⇒ existing sessions and new projects behave exactly as today until a user
  opts a specific LFO into sync.

### Division set

A single shared constant `LFO_SYNC_DIVISIONS` (new, in `@fiddle/shared`) is the source of
truth for the ordered list, its labels, and its beats-per-cycle. Order is
**slowest → fastest** so the knob sweeps left(slow)→right(fast), matching the free-mode
Hz knob's direction. The **index is the wire encoding** and is append-stable once shipped.

Beats-per-cycle uses quarter-note = 1 beat; dotted `.` = ×1.5 duration, triplet `T` = ×2/3:

| idx | label | beats/cycle | Hz @ 120 BPM |
|---|---|---|---|
| 0 | `1/1.`  | 6      | 0.3333 |
| 1 | `1/1`   | 4      | 0.5 |
| 2 | `1/2.`  | 3      | 0.6667 |
| 3 | `1/1T`  | 8/3    | 0.75 |
| 4 | `1/2`   | 2      | 1.0 |
| 5 | `1/4.`  | 1.5    | 1.3333 |
| 6 | `1/2T`  | 4/3    | 1.5 |
| 7 | `1/4`   | 1      | 2.0 |
| 8 | `1/8.`  | 0.75   | 2.6667 |
| 9 | `1/4T`  | 2/3    | 3.0 |
| 10 | `1/8`  | 0.5    | 4.0 |
| 11 | `1/16.`| 0.375  | 5.3333 |
| 12 | `1/8T` | 1/3    | 6.0 |
| 13 | `1/16` | 0.25   | 8.0 |
| 14 | `1/32.`| 0.1875 | 10.6667 |
| 15 | `1/16T`| 1/6    | 12.0 |
| 16 | `1/32` | 0.125  | 16.0 |
| 17 | `1/32T`| 1/12   | 24.0 |

**Derivation:** `Hz = bpm / (60 × beatsPerCycle)`. Default `1/16` = index 13.

### Rate derivation — lives in `AudioEngine`

`AudioEngine` already holds `project.bpm` and, since Phase 5 / D17, is the sole writer of
worklet params (via the applied-command stream). The persisted `lfo*.rate` leaf is
**never overwritten**; instead the effective Hz sent to the kernel is computed at push
time:

```
effectiveHz(lfoN) = lfoN.sync
  ? bpm / (60 * beats(lfoN.div))
  : lfoN.rate            // free-mode leaf, as today
```

Two hooks in `AudioEngine.onCommand`:

1. **LFO slice edits.** When a `['tracks', i, 'engines', 'synth2', 'lfoN', ...]` edit
   arrives (`rate`, `sync`, or `div`), recompute `effectiveHz` for that LFO and push
   **only** `applyParams({ 'lfoN.rate': effectiveHz })`. `sync`/`div` are not sent to the
   kernel (it doesn't read them). The existing generic `engines.synth2` branch pushes the
   whole `lfoN` sub-object today; this replaces the rate field in that push with the
   derived value when synced.
2. **BPM changes (new behavior).** `onCommand` currently early-returns on any non-`tracks`
   path (line ~250, comment "bpm etc.: sequencer pulls per tick"). Add a `bpm` branch:
   on a `['bpm']` edit, iterate all synth2 engines and, for each LFO whose `sync` is on,
   recompute `effectiveHz` and re-push `lfoN.rate`. Free-mode LFOs and all other params
   are untouched, preserving the existing "sequencer pulls bpm per tick" behavior for
   everything else.

This keeps tempo logic in one place, leaves the kernel and the persisted state clean, and
is deterministic across clients: a peer receives `{sync, div, rate, bpm}` and derives an
identical Hz locally. Modulation is unaffected — `lfo*.rate` remains a mod destination and
the exp ±4-octave mod rides on whatever base rate (free or derived) is in the block.

### UI

In `Synth2Panel.vue`, reuse the existing `sync-btn`/`loop-btn` button pattern. Per LFO:

- A **`SYNC`** button next to the LFO header toggling `lfo*.sync`
  (`ks.set(['lfoN', 'sync'], !params.lfoN.sync)`), styled `active` when on — identical to
  the osc `sync-btn`.
- The **Rate knob binds conditionally**:
  - SYNC **off** → today's knob: `lfo*.rate`, `min 0.01 max 2000 step 0.01 format hz
    curve exp` (now with Part A's decimals).
  - SYNC **on** → the same knob bound to the division index: `min 0 max 17 step 1` linear,
    readout shows the division label.

**Division label rendering + storage adapter.** Add an optional `labels?: string[]` prop to
`Knob.vue`: when present, the readout is `labels[Math.round(val)]` (bypassing the `format`
switch). Because the `lfo*.div` **leaf is stored as a label string** but the knob is
numeric, the panel converts:

- `:modelValue` → `LFO_SYNC_DIVISIONS.findIndex(d => d.label === params.lfoN.div)`
  (fallback to the default index if not found).
- `@update:modelValue` (an index) →
  `ks.set(['lfoN', 'div'], LFO_SYNC_DIVISIONS[index].label)`.

The `WavePreview` (shape-only) is unaffected.

---

## Testing

**Shared (`@fiddle/shared`):**
- `LFO_SYNC_DIVISIONS`: 18 entries, ordered slow→fast, unique labels; beats values and the
  `Hz = bpm/(60×beats)` derivation match the table above at a reference BPM (e.g. 120).
- Descriptor derivation contracts already in the repo (schema / accept-list / defaults /
  block layout) auto-include the 4 new rows — assert the 4 keys appear and that
  `lfo*.div` round-trips its label through `encodeEnum`/`decodeEnum`.

**Client formatter (`Knob.vue` / formatter unit):**
- `hz` boundary cases: `0.25 → "0.25Hz"`, `2.5 → "2.5Hz"`, `9.99 → "9.99Hz"`,
  `10 → "10Hz"`, `440 → "440Hz"`, `2000 → "2.0k"`.

**Client `AudioEngine`:**
- Synced LFO pushes derived Hz (`1/16` @ 120 BPM → 8 Hz), not the free leaf.
- BPM change re-pushes only synced LFOs; free-mode LFOs and other params are not re-pushed.
- Free mode pushes the raw `rate` leaf.
- Toggling SYNC off restores the free `rate` leaf to the kernel.

**Mandatory browser verification (dev:obs, per repo rule):**
- Open synth2, enable SYNC on a slow LFO, confirm the readout shows a division and the
  modulation locks to the grid audibly/visually.
- Change project BPM and confirm the synced LFO tracks tempo; a free-mode LFO does not.
- Toggle SYNC off and confirm the free Hz value returns.
- Clean console; close tabs when done.

---

## Known limitation (not a blocker)

Saved sessions created before this change won't sync the 4 new leaves until re-saved — the
recurring slice-level server-normalize gap ([[synth2-old-session-sync-gap]]) that affects
every descriptor append. New sessions, local defaults, and file Open/New are fine. This is
consistent with every prior descriptor-table append and is noted here for completeness, not
fixed in this iteration.

## Files touched (anticipated)

- `packages/shared/src/engines/synth2-descriptors.ts` — append 4 rows; export
  `LFO_SYNC_DIVISIONS`.
- `packages/shared/src/engines/*` barrel — export the new constant/types.
- `packages/client/src/audio/AudioEngine.ts` — effective-rate derivation + bpm branch.
- `packages/client/src/components/Knob.vue` — `hz` decimals (Part A) + optional `labels`
  prop.
- `packages/client/src/components/Synth2Panel.vue` — per-LFO SYNC button + conditional
  Rate-knob binding + div index↔label adapter.
- Tests alongside each of the above.
