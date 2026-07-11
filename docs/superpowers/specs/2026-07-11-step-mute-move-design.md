# Step Mute-Toggle + Move-Selection Keyboard Commands — Design

**Date:** 2026-07-11
**Status:** Approved (brainstormed with user; decisions below were made explicitly)
**Branch:** `feat/step-mute-move`
**Extends:** `docs/superpowers/specs/2026-07-10-keyboard-step-selection-design.md`
(merged `ee660ae`) and the drag-select follow-up (merged `ebe9ff5`).

## Goal

Two new tracker keyboard commands operating on the existing step-row
selection:

1. **Mute toggle** — `M` flips the `muted` flag of every selected step.
2. **Move selection** — `Alt+ArrowUp` / `Alt+ArrowDown` moves the selected
   block one row up/down the track, IDE move-line style (VS Code's
   Alt+↑/↓; Option+↑/↓ on macOS).

## Non-goals (explicit)

- **No shared/server changes** — both commands write existing `Step`
  leaves (`muted`, and whole-step contents for move) through the
  CommandBus; the wire format, accept-list, and schema are untouched.
- **No KeyboardService changes** — dispatch, guards (editable, modal
  stand-down, repeat), and priority are reused as-is.
- **No selection-store changes** — `place`, `extendTo`, `validSelection`
  already express everything the commands need.
- **No new UI** — muted rows already render via `.step-row.step-muted`;
  the moved block is visible through the existing `.selected` styling.

## Decisions (brainstormed)

1. **Per-step flip** (USER DECIDED, over uniform mute-all-then-unmute-all):
   each selected step independently inverts `muted`. Mixed selections stay
   mixed (inverted). Rests are included — consistent with the per-row mute
   button, which also toggles rests.
2. **Clamp at edges** (USER DECIDED, over wrap-around): moving up with the
   block at row 0, or down with the block at the last pattern row, is a
   complete no-op — nothing dispatched, selection unchanged. Matches IDE
   move-line and is safe under key repeat.
3. **Binding = `alt+arrowup` / `alt+arrowdown`** (user deferred; VS Code's
   move-line chosen). Strict descriptor matching already guarantees no
   collision with plain arrows (cursor) or shift+arrows (extend).
4. **Both commands require a selection** (`isEnabled: hasSelection`). Move
   has `allowRepeat: true` (holding the key walks the block); mute does not.
5. **Selection follows the moved block, preserving orientation** — anchor
   and head both shift by ±1, so the cursor stays on the same end and
   shift+arrow extension keeps working from the same head afterwards.

## Design

### 1. Bindings — `keyboard/bindings.ts` (+3 rows)

```ts
'tracker.toggleMute': 'm',
'tracker.moveUp': 'alt+arrowup',
'tracker.moveDown': 'alt+arrowdown',
```

The known `e.key` non-Latin-layout caveat (an existing BACKLOG entry:
bindings match `KeyboardEvent.key`, so `m` will not fire on e.g. a Cyrillic
layout) applies to the new `m` binding; same accepted trade-off, no new
work.

### 2. Draft producers — `project/mutations.ts` (pure, unit-tested)

```ts
/** Copies of steps[start..end] with `muted` inverted per step. */
export function toggleMuteRangeDraft(
  steps: readonly Step[], start: number, end: number,
): Step[]
```

```ts
/**
 * IDE move-line over the steps buffer: the selected block [start..end]
 * shifts one row toward `direction`, and the displaced neighbor row
 * (start-1 when moving up, end+1 when moving down) jumps to the other
 * side of the block. Returns the affected window only:
 *   up   -> rows [start-1 .. end]   (draft[0] is the new start-1 row)
 *   down -> rows [start .. end+1]
 * Precondition (caller-enforced): the neighbor row exists inside the
 * pattern window — the command layer clamps before calling.
 */
export function moveRangeDraft(
  steps: readonly Step[], start: number, end: number,
  direction: 'up' | 'down',
): Step[]
```

Both return deep-enough copies (`{ ...s }` per step, same as the existing
producers) and never mutate their input.

### 3. Ops — `app/projectOps.ts` (+2 ops on the object consumed by trackerCommands)

```ts
toggleMuteRange(trackId: number, start: number, end: number): void
// dispatchStepsRange(trackId, start, toggleMuteRangeDraft(...))
// -> the diff emits ONLY the changed `muted` leaves.

moveStepRange(trackId: number, start: number, end: number,
              direction: 'up' | 'down'): void
// windowStart = direction === 'up' ? start - 1 : start;
// dispatchStepsRange(trackId, windowStart, moveRangeDraft(...))
```

Same draft-diff-dispatch shape as `clearStepRange`/`pasteSteps`: every
dispatched leaf carries priorValue (undo-ready), syncs through the
CommandBus, and unchanged fields produce no ops.

### 4. Commands — `keyboard/trackerCommands.ts` (+3 entries)

- `tracker.toggleMute` — `context: 'tracker'`, `isEnabled: hasSelection`,
  `run`: read `sel()`, call `ops.toggleMuteRange(s.trackId, s.start, s.end)`.
- `tracker.moveUp` / `tracker.moveDown` — `context: 'tracker'`,
  `allowRepeat: true`, `isEnabled: hasSelection`, `run` (shared helper
  `moveSelection(direction)`):
  1. `s = sel()`; bail if null.
  2. Clamp guard: up with `s.start === 0`, or down with
     `s.end === patternLength - 1` (read from
     `project.tracks[s.trackId].patternLength`) → return (USER DECIDED:
     no-op, nothing dispatched).
  3. `ops.moveStepRange(s.trackId, s.start, s.end, direction)`.
  4. Move the selection with the block, preserving orientation
     (`delta = direction === 'up' ? -1 : 1`):
     if `s.head === s.end` → `place(trackId, s.start + delta)` then
     `extendTo(trackId, s.end + delta)`; else `place(trackId, s.end + delta)`
     then `extendTo(trackId, s.start + delta)`.

The existing cursor auto-scroll watcher in `Tracker.vue` follows the moved
head automatically (pattern length > 16 gate unchanged). `validSelection`
already revalidates against `patternLength`, so a stale selection can never
mute or move rows outside the live window.

`TrackerCommandDeps.ops` grows the two new methods; no other dep changes.

### 5. Files touched

| File | Change |
| --- | --- |
| `packages/client/src/keyboard/bindings.ts` | +3 binding rows |
| `packages/client/src/project/mutations.ts` | `toggleMuteRangeDraft`, `moveRangeDraft` |
| `packages/client/src/project/mutations.test.ts` | producer tests |
| `packages/client/src/app/projectOps.ts` | `toggleMuteRange`, `moveStepRange` ops |
| `packages/client/src/keyboard/trackerCommands.ts` | +3 commands, `moveSelection` helper |
| `packages/client/src/keyboard/trackerCommands.test.ts` | command tests |

No shared, server, store, KeyboardService, or component files change.

## Testing

**`mutations.test.ts`:**

- `toggleMuteRangeDraft`: mixed selection flips per-step (muted→unmuted and
  vice versa in one call); rests get flipped too; input not mutated;
  returned length is `end - start + 1`.
- `moveRangeDraft` up: moving [2..4] up returns rows for indices 1..4 =
  [old 2, old 3, old 4, old 1] — the block first, the displaced row last.
  Test asserts exactly this via distinct `note` markers.
- `moveRangeDraft` down: moving [2..4] down returns rows for indices 2..5 =
  [old 5, old 2, old 3, old 4].
- Single-row block moves both directions; copies are not references into
  the input array.

**`trackerCommands.test.ts`** (existing harness: fake deps, spy ops):

- `tracker.toggleMute`: disabled without selection; calls
  `toggleMuteRange(trackId, start, end)`; selection untouched afterwards.
- `tracker.moveUp` at `start === 0`: no op call, selection unchanged.
- `tracker.moveDown` at `end === patternLength - 1`: no op call, selection
  unchanged.
- `tracker.moveDown` mid-track: op called with correct args; selection
  shifts +1 with head still on the same end (test both orientations:
  head === end and head === start).
- `tracker.moveUp` mid-track: mirror of the above with −1.
- Binding table: the 3 new ids parse (`parseBinding`) and are strict-match
  distinct from `arrowup`/`shift+arrowup` (covered by existing
  bindings-table test patterns).

**Browser verification** (mandatory; dev:obs, throwaway session, clean
console, close browser):

- Select a mixed muted/unmuted range, press M — each step flips (dim state
  visibly inverts per row); press M again — original state restored.
- Alt+↓ / Alt+↑ walks a block containing distinct notes past neighbor rows
  in both layouts; the neighbor row visibly jumps to the block's other side.
- Edge clamp: Alt+↑ with block at row 0 and Alt+↓ at the pattern end do
  nothing.
- Hold Alt+↓ (repeat) at pattern length 32 — block walks and auto-scroll
  follows.
- Shift+arrow after a move extends from the same cursor end.
- Reload — moved/muted steps persisted (synced through CommandBus).
- M inside a text input (rename field) types "m", no mute; modal open →
  keys stand down.

## Risks / notes

- Key repeat on move dispatches one op batch per repeat tick, bounded by
  (block size + 1) step diffs — far below the rate-limit op-storm
  threshold (the bulk-load incident involved hundreds of leaves in one
  burst; a repeat tick here is tens at most for realistic selections).
- `moveRangeDraft`'s precondition (neighbor row exists) is enforced by the
  command layer's clamp guard; the producer may also defensively return
  `[]` on violation, but the guard is the contract.
