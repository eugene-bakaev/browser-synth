# Cmd+Click Multi-Select for Tracker Steps — Design

**Date:** 2026-07-11
**Status:** Approved (brainstormed with user; decisions below were made explicitly)
**Branch:** `feat/cmd-click-multi-select`
**Extends:** `docs/superpowers/specs/2026-07-10-keyboard-step-selection-design.md`
(merged `ee660ae`), the drag-select follow-up (merged `ebe9ff5`), and the
mute-toggle/move-selection commands (merged `610603c`).

## Goal

Cmd+click (Ctrl+click on Windows/Linux) toggles individual step rows in and
out of the selection, so a selection may be **non-contiguous** — and every
existing selection operation (mute, clear, copy/cut/paste, alt+arrow move)
has well-defined semantics on a gapped selection.

## Decisions (brainstormed, USER DECIDED)

1. **All operations support gaps** — mute/clear, copy/paste, and move must
   all work on gapped selections; none is disabled or degraded.
2. **Single track** — a multi-selection never spans tracks. Cmd+click on a
   different track starts a fresh selection there.
3. **Copy/paste = preserve gaps, transparent** — the clipboard holds the
   full span from the first to the last selected row **with holes**; pasting
   writes only the selected cells and leaves destination rows under the
   holes untouched.
4. **Move = rigid constellation** — alt+arrow shifts the whole selected
   shape by one row, gaps preserved; displaced unselected rows fill the
   vacated slots preserving their relative order. Clamps to a complete no-op
   when any selected row sits at the pattern edge in the move direction.
5. **Shift extends the active segment only** (Excel/IDE convention) — the
   selection is conceptually "frozen rows + one active segment"; shift+click
   and shift+arrows reshape only the active segment, earlier (frozen) rows
   persist. Shrinking the active segment never eats independently selected
   rows.
6. **Representation = frozen row-set + active segment** (approach A, chosen
   over a segment list and over a pure row set): the store keeps today's
   `{trackId, anchor, head}` as the active segment plus a `frozen:
   Set<number>`. A selection with `frozen` empty is bit-for-bit today's
   model. A pure row set was rejected because it cannot express
   active-segment shrink (decision 5); a segment list was rejected as YAGNI
   (frozen segments only ever matter as a set of rows).

## Non-goals (explicit)

- **No cross-track selection** (decision 2).
- **No shared/server changes** — all ops still write existing `steps.*`
  leaves through the CommandBus; wire format, accept-list, schema untouched.
- **No KeyboardService / bindings changes** — M, alt+arrows, mod+C/X/V,
  Escape, arrows are all reused; dispatch, guards, and priority as-is.
- **No new CSS** — `.selected` / `.sel-cursor` already render per-row;
  a gapped selection renders correctly with zero style changes.
- **click-outside-deselect and modal stand-down unchanged.**

## Design

### 1. Selection store — `stores/selection.ts`

New ref alongside `trackId`/`anchor`/`head`:

```ts
const frozen = ref<Set<number>>(new Set()); // rows committed by cmd+click; same track
```

`validSelection` generalizes (same self-validating read discipline —
consumers must never read the raw refs):

```ts
export interface ValidSelection {
  trackId: number;
  rows: readonly number[];   // sorted, deduped, clamped to the pattern window
  ranges: readonly { start: number; end: number }[]; // contiguous runs of rows
  first: number;             // rows[0]
  last: number;              // rows[rows.length - 1]
  head: number;              // the cursor, clamped (unchanged meaning)
}
```

Computation: `rows` = (active range `[min(anchor,head)..max(anchor,head)]`
clamped to `[0..patternLength-1]`) ∪ (`frozen` ∩ window), sorted. Empty →
`null` (as is a missing/disabled track or `trackId === null`). Stored refs
are never mutated by validation — pattern shrink filters rows out of the
*read* only, exactly like today.

Actions:

- `place(tid, row)` — unchanged, **plus `frozen.clear()`** (plain click
  resets the whole selection).
- `extendTo(tid, row)` / `extendCursor(delta)` — unchanged; reshape the
  active segment only, `frozen` untouched.
- `moveCursor(delta)` — unchanged collapse-and-move, **plus
  `frozen.clear()`** (plain arrows collapse the multi-selection).
- **`toggleRow(tid, row)`** — new; the cmd+click primitive:
  - different track, or no current selection → `place(tid, row)`;
  - row **not** selected → flatten the active segment's rows into `frozen`,
    then `anchor = head = row` (new collapsed active segment);
  - row **is** selected → flatten everything into one set, delete `row`;
    if empty → `clear()`; otherwise the cursor stays at the old head if the
    head is still selected, else moves to the nearest remaining selected
    row (ties → the lower row); rebuild state as `frozen` = set minus the
    cursor row, active segment collapsed at the cursor.
- **`shiftAll(delta)`** — new: add `delta` to every frozen row and to
  `anchor` and `head`. Selection-follow for the constellation move;
  orientation is preserved because anchor and head shift together.
  Caller guarantees the result stays in the window (the move command clamps
  first).
- **`selectRows(tid, rows)`** — new: select exactly `rows` (sorted,
  non-empty): `frozen` = all but the last row, active segment collapsed at
  the last row. Used to re-select the pasted constellation.
- `clear()` — unchanged, **plus `frozen.clear()`**.
- `isSelected(tid, row)` — backed by a `Set` computed over
  `validSelection.rows` (the template calls it per row; O(1) lookup).

### 2. Gesture — `Tracker.vue`

`onStepPointerDown` grows one branch ahead of the shift branch:

- `e.button === 0 && (e.metaKey || e.ctrlKey)` → `selection.toggleRow(trackId, row)`.
- If the row is selected afterwards (a toggle-**on**), start the existing
  drag tracking (`dragPointerId`/`lastDragRow` + pointer capture) so
  **cmd+drag extends the fresh active segment** — Excel's ctrl+drag
  adds-a-range for free, because pointermove already calls `extendTo`.
- A toggle-**off** starts no drag.
- Shift branch and plain branch unchanged.

macOS note: Ctrl+click reaches the page as a right-click (`button === 2` /
contextmenu), so the existing `button !== 0` guard already excludes it —
Cmd is the macOS gesture, Ctrl covers Windows/Linux. No platform seam is
needed in the component.

Pointermove / pointerup / pointercancel teardown is unchanged: a drag only
ever reshapes the active segment.

### 3. Draft producers — `project/mutations.ts` (pure, unit-tested)

All rows-based producers receive `rows` sorted ascending (guaranteed by
`validSelection`), build a **span draft** covering `[rows[0] ..
rows[rows.length-1]]` (plus the displaced neighbor for move), and copy
unselected rows through unchanged — `dispatchStepsRange`'s diff then emits
only genuinely changed leaves. One producer, one dispatch per op.

```ts
/** Span draft [first..last]: members get `muted` inverted, gaps copied through.
 *  REPLACES toggleMuteRangeDraft (contiguous rows = identical output). */
export function toggleMuteRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[]

/** Span draft [first..last]: members become empty steps, gaps copied through. */
export function clearRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[]

/** Transparent paste: span draft at `start`, length min(cells.length, steps.length - start).
 *  Non-null cells overwrite; null cells copy the destination row through. */
export function pasteCellsDraft(steps: readonly Step[], start: number, cells: readonly (Step | null)[]): Step[]

/** Rigid constellation move. Window = [first-1..last] (up) or [first..last+1]
 *  (down). Selected rows shift by ±1; unselected rows inside the window fill
 *  the vacated slots preserving their relative order. Contiguous rows
 *  reproduce moveRangeDraft's output exactly — REPLACES moveRangeDraft.
 *  Precondition (caller-enforced clamp): first > 0 for up, last <
 *  steps.length - 1 for down; defensively returns [] on violation. */
export function moveRowsDraft(steps: readonly Step[], rows: readonly number[], direction: 'up' | 'down'): Step[]
```

Worked move example (rows 2,5,6; down): window `[2..7]`; selected land on
3,6,7; unselected old rows 3,4,7 fill slots 2,4,5 in order → slot 2 ← old 3,
slot 4 ← old 4, slot 5 ← old 7.

All producers return per-step copies (`{ ...s }`) and never mutate input.

### 4. Clipboard — `stores/stepClipboard.ts`

`rows` widens from `Step[]` to `(Step | null)[]` — a span with holes
(`null` = unselected row). Deep-copy on `set` unchanged for non-null cells.
By construction the first and last cells are non-null. Enablement stays
"length > 0". Still LOCAL-ONLY, never synced.

### 5. Ops — `app/projectOps.ts`

Range signatures become rows signatures (same draft-diff-dispatch shape;
every leaf carries priorValue):

```ts
toggleMuteRows(trackId: number, rows: readonly number[]): void
clearStepRows(trackId: number, rows: readonly number[]): void   // replaces clearStepRange
moveStepRows(trackId: number, rows: readonly number[], direction: 'up' | 'down'): void
// windowStart = up ? rows[0] - 1 : rows[0]
pasteSteps(trackId: number, cursor: number, cells: readonly (Step | null)[]): number[]
// returns the ABSOLUTE row indices actually written (non-null cells inside
// the clipped window) — the command re-selects exactly these.
```

Internal contiguous callers (if any use `clearStepRange` today) pass an
explicit contiguous rows array; `dispatchStepsRange` itself is unchanged.

### 6. Commands — `keyboard/trackerCommands.ts`

Reads switch from `s.start`/`s.end` to `s.rows`/`s.first`/`s.last`:

- `tracker.copy` — clipboard = span `[first..last]` with `null` holes:
  `steps.slice(first, last + 1).map((step, i) => rowSet.has(first + i) ? step : null)`.
- `tracker.cut` / `tracker.clear` — `ops.clearStepRows(s.trackId, s.rows)`
  (cut copies first). Selection stays.
- `tracker.paste` — `written = ops.pasteSteps(s.trackId, s.first, cells)`;
  if `written.length > 0` → `selection.selectRows(s.trackId, written)`
  (the selection mirrors the pasted constellation, so M-after-paste hits
  only pasted steps).
- `tracker.toggleMute` — `ops.toggleMuteRows(s.trackId, s.rows)`.
- `tracker.moveUp/Down` — clamp: up no-ops when `s.first === 0`, down when
  `s.last === patternLength - 1` (complete no-op, nothing dispatched);
  else `ops.moveStepRows(...)` then `selection.shiftAll(±1)`.
- Cursor/extend/deselect commands unchanged (the store handles frozen).

`TrackerCommandDeps.ops` changes accordingly; enablement predicates
unchanged.

### 7. Files touched

| File | Change |
| --- | --- |
| `packages/client/src/stores/selection.ts` | `frozen` ref, generalized `ValidSelection`, `toggleRow`/`shiftAll`/`selectRows`, frozen-aware `place`/`moveCursor`/`clear`, Set-backed `isSelected` |
| `packages/client/src/stores/selection.test.ts` | store tests (new file if none exists) |
| `packages/client/src/stores/stepClipboard.ts` | `(Step \| null)[]` cells |
| `packages/client/src/components/Tracker.vue` | cmd/ctrl branch in `onStepPointerDown`, drag start on toggle-on only |
| `packages/client/src/components/Tracker.test.ts` | gesture tests |
| `packages/client/src/project/mutations.ts` | 4 rows-producers (2 replace range-producers) |
| `packages/client/src/project/mutations.test.ts` | producer tests incl. contiguous regression oracles |
| `packages/client/src/project/index.ts` | barrel exports |
| `packages/client/src/app/projectOps.ts` | rows-based op signatures, `pasteSteps` → `number[]` |
| `packages/client/src/keyboard/trackerCommands.ts` | rows-based reads, constellation clamp, `selectRows` re-select |
| `packages/client/src/keyboard/trackerCommands.test.ts` | command tests on gapped selections |

No shared, server, KeyboardService, bindings, CSS, or composable changes.

## Testing

**`selection.test.ts`:**
- `toggleRow`: fresh place (no selection / other track); toggle-on freezes
  the active segment and collapses at the new row; toggle-off keeps the
  cursor at the old head when still selected, else nearest remaining row
  (tie → lower); toggling the only selected row clears; cross-track resets.
- `validSelection`: rows sorted/deduped (frozen overlapping the active
  range), ranges derived, first/last/head; pattern shrink filters frozen
  rows from the read without mutating state; frozen-empty selection
  identical to today's shape.
- `shiftAll` shifts frozen + anchor + head; `selectRows` selects exactly
  the given rows with head on the last; `place`/`moveCursor` clear frozen;
  `extendTo`/`extendCursor` preserve frozen.

**`mutations.test.ts`:**
- Contiguous regression oracles: `toggleMuteRowsDraft` and `moveRowsDraft`
  with contiguous rows reproduce the old range-producers' documented
  outputs verbatim (existing test expectations carry over).
- Gapped mute flip (mixed muted/unmuted incl. rests); gapped clear leaves
  gap rows untouched.
- `moveRowsDraft` 2/5/6 worked example, both directions, via distinct note
  markers; single gapped pair; defensive `[]` at both buffer edges.
- `pasteCellsDraft`: holes copy destination through, non-null overwrite,
  clipping at the pattern end.
- No input mutation anywhere; copies are not references.

**`trackerCommands.test.ts`:**
- Gapped copy produces `[cell, null, …, cell]`; cut clears members only.
- Paste re-selects the written constellation (mock returns absolute rows);
  0-written leaves selection alone.
- Move clamps at `first === 0` / `last === max` on gapped selections;
  mid-track gapped move dispatches rows + `shiftAll` result verified for
  both head orientations.
- `toggleMute` passes `rows`; plain arrows collapse a gapped selection to a
  single row.

**`Tracker.test.ts`:**
- cmd+click (metaKey) toggles on/off; ctrlKey path too.
- cmd+click toggle-on starts drag tracking (pointermove extends the new
  segment); toggle-off does not.
- shift+click still extends; plain click resets a gapped selection.

**Browser verification** (mandatory; dev:obs, throwaway session, clean
console, close browser):
- Build a gapped selection with cmd+click in both layouts; `.selected`
  renders on exactly the chosen rows.
- Cmd+click a selected row — it leaves the selection; cursor lands per the
  rules.
- M flips only the selected rows; M again restores.
- Copy a gapped constellation, paste over a region with existing notes —
  holes leave destination rows intact; selection mirrors the paste.
- Cut a gapped selection — gaps untouched.
- Alt+↓/↑ walks the constellation past unselected neighbors (they jump
  through the gaps per the worked example); hold for repeat + auto-scroll;
  clamps at both edges.
- Shift+click after cmd+click extends only the active segment; earlier
  rows persist. Shift+arrow ditto.
- Plain click and Escape reset; reload persists step edits (selection is
  local and gone — expected).
- Cmd+click inside a modal stands down; rename input types normally.

## Risks / notes

- **Op batch size**: a gapped op dispatches at most (span length) step
  diffs — same order as the existing range ops; no rate-limit concern.
- **Clipboard shape change** is invisible outside the client (LOCAL-ONLY
  store), but `tracker.paste` enablement and all paste tests must use the
  new `(Step | null)[]` shape.
- **`moveRowsDraft` replaces `moveRangeDraft`** (and mute likewise): the
  contiguous regression oracles in `mutations.test.ts` are the guard that
  the generalization preserves merged behavior (`610603c`).
- `shiftAll` trusts the command-layer clamp, mirroring the existing
  producer-precondition pattern; `validSelection` would still self-heal an
  out-of-window row on the next read.
