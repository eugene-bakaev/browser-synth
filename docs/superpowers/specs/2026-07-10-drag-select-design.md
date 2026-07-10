# Drag-Select + Click-Outside Deselect — Design

**Date:** 2026-07-10
**Status:** Approved (brainstormed with user; all decisions below were made explicitly)
**Branch:** `feat/drag-select`
**Extends:** `docs/superpowers/specs/2026-07-10-keyboard-step-selection-design.md`
(merged as `ee660ae`); implements the two user BACKLOG entries "Drag-select:
mousedown + drag over steps should extend the selection" and "Click outside a
track with selected steps should cancel the selection".

## Goal

Add the two missing mouse gestures to step-row selection:

1. **Drag-select** — pressing the mouse on a step-number cell and dragging
   over neighboring rows in the same track live-extends the selection over
   the dragged range (the familiar text/DAW gesture).
2. **Click-outside deselect** — pressing the mouse outside every Tracker
   card while a selection exists clears it.

Both gestures are layered on the existing selection store with **zero store
API changes** — `place`, `extendTo`, `clear`, and `validSelection` already
express everything they need.

## Non-goals (explicit)

- **No selection-store changes** — no new state, no new actions.
- **No keyboard-system changes** — arrows, copy/cut/clear/paste, Escape keep
  operating on whatever the mouse gestures produce.
- **No cross-track drag** — the single-track selection model stands; a drag
  never hops to another track.
- **No touch drag-select** — drag-select is a mouse/pen gesture. No
  `touch-action` change: a finger-drag on the step column still scrolls the
  page (the browser's scroll takeover fires `pointercancel`, which simply
  ends the drag with the selection as-is).
- **No shared/server changes** — selection stays LOCAL-ONLY.

## Decisions (brainstormed)

1. **Drag captures to the origin track.** Once a drag starts, the selection
   follows the pointer's *vertical* position, clamped to the track's rows,
   no matter where the pointer goes horizontally — like text selection and
   DAW piano rolls. Releasing anywhere ends the drag. (Rejected: freezing
   extension at the column boundary — sticky, unfamiliar.)
2. **"Outside" = outside every Tracker card.** Clicks on controls *inside*
   any `.tracker-container` (knobs, note cells, mute, rename, other tracks'
   panels) keep the selection — you can tweak a sound without losing your
   range. Only presses on page space outside all Tracker cards clear it.
   Presses inside an open `[aria-modal="true"]` dialog also keep it,
   consistent with the keyboard system's modal stand-down. (Rejected:
   any-non-step-cell clears; outside-the-origin-track clears.)
3. **Both layouts.** Drag-select works in the overview grid and the focused
   tracker — both render the same `Tracker` component, so one implementation
   covers both.
4. **Selection moves to press-time.** The `.col-step` handler moves from
   `@click` to `@pointerdown` (standard DAW feel). A press with no drag
   behaves exactly like today's click; shift+press extends as before.

## Approach (chosen: Pointer Events + pointer capture + geometry rows)

`setPointerCapture` on the scrollable `.tracker-steps` element routes every
subsequent `pointermove`/`pointerup` for that pointer to it regardless of
where the pointer is — exactly the capture-to-origin-track semantics, with
no window-level listeners, no unmount-mid-drag teardown bookkeeping, and a
guaranteed `pointerup` even when the button is released outside the browser
window. Row lookup is geometric (vertical offset ÷ uniform row height), not
event-target hit-testing, so it works while the pointer is horizontally
outside the narrow step column.

Rejected alternatives:

- `mousedown` + window `mousemove`/`mouseup` listeners — manual teardown,
  stuck-drag edge cases on release outside the window, mouse-only.
- `mouseover` per cell while a flag is set — extension stops the moment the
  pointer leaves the step column; that is the freeze-at-boundary behavior
  decision 1 rejected.

## Design

### 1. Drag-select in `Tracker.vue`

Template: `.col-step` (step-row cells only; the header "STEP" cell is
untouched) changes from `@click="onStepCellClick($event, i)"` to
`@pointerdown="onStepPointerDown($event, i)"`. The `.tracker-steps`
container gains `@pointermove="onStepsPointerMove"`,
`@pointerup="onStepsPointerUp"`, `@pointercancel="onStepsPointerUp"`.

Local drag state (plain refs, not store state): `dragPointerId:
number | null` and `lastDragRow: number | null`.

- **`onStepPointerDown(e, row)`** — ignore unless `e.button === 0`.
  `e.preventDefault()` (suppresses native text-selection/focus side
  effects). Shift held → `selection.extendTo(props.trackId, row)`, else
  `selection.place(props.trackId, row)` — the exact bodies of today's
  `onStepCellClick`, which this function replaces. Then start the drag:
  `stepsEl.setPointerCapture(e.pointerId)` (guarded `try/catch` — jsdom
  and exotic embeds may not implement it), `dragPointerId = e.pointerId`,
  `lastDragRow = row`.
- **`onStepsPointerMove(e)`** — return unless
  `e.pointerId === dragPointerId`. Compute the row under the pointer:
  clamp `e.clientY` to the container's bounding rect
  (`[rect.top, rect.bottom - 1]`), subtract `rect.top`, add
  `stepsEl.scrollTop`, divide by the first `.step-row` child's
  `offsetHeight` (guard: bail if no row / zero height), floor, clamp to
  `[0, patternLength - 1]`. If the result differs from `lastDragRow`,
  `selection.extendTo(props.trackId, row)` and update `lastDragRow` —
  no store churn while the pointer wiggles inside one row.
  Clamping to the *visible* rect edge (not to the full scroll height)
  means dragging past the top/bottom extends to the edge row, the
  existing cursor auto-scroll watcher scrolls the next row into view,
  and the following `pointermove` reaches it — free edge auto-scroll.
- **`onStepsPointerUp(e)`** (also bound to `pointercancel`) — return
  unless `e.pointerId === dragPointerId`. Defensively
  `releasePointerCapture(e.pointerId)` in `try/catch` (browsers release
  implicitly on pointerup), then `dragPointerId = null`,
  `lastDragRow = null`. The selection is already live; there is nothing
  to commit.

Shift+press+drag composes naturally: the press extends from the existing
anchor, the drag keeps moving the head.

### 2. Click-outside deselect — `composables/useClickOutsideDeselect.ts`

New composable following the existing `composables/useLobby.ts` pattern:

```ts
export function useClickOutsideDeselect(selection: SelectionStore): void
```

- `onMounted`: `document.addEventListener('pointerdown', handler, true)`
  (capture phase). `onBeforeUnmount`: remove it.
- Handler: if `selection.validSelection === null` → return. If
  `e.composedPath()` contains an `Element` whose `classList` has
  `tracker-container` **or** which has the attribute `aria-modal="true"`
  → return. Else `selection.clear()`.
- The handler never calls `preventDefault` or `stopPropagation`, so it
  cannot swallow or race the `.col-step` handlers or any other click
  target. Keying off pointer**down** means a drag that *ends* outside a
  tracker never clears — its down happened inside a `.tracker-container`.
- Registered once in `StudioView.vue`, next to the existing
  tracker-keyboard-command registration (StudioView owns the trackers).

### 3. Files touched

| File | Change |
| --- | --- |
| `packages/client/src/components/Tracker.vue` | `@click` → pointer handlers; drag state + 3 handlers; `onStepCellClick` removed |
| `packages/client/src/composables/useClickOutsideDeselect.ts` | **new** |
| `packages/client/src/composables/useClickOutsideDeselect.test.ts` | **new** |
| `packages/client/src/views/StudioView.vue` | one composable call + import |
| `packages/client/src/components/Tracker.test.ts` | click tests → pointer tests; drag tests |

No shared, server, store, or keyboard files change.

## Testing

**`Tracker.test.ts`** (jsdom: stub `setPointerCapture` /
`releasePointerCapture` on the container element; mock
`getBoundingClientRect` and first-row `offsetHeight` for geometry):

- pointerdown on a step cell places the selection; shift+pointerdown
  extends (replaces the current click/shift+click tests).
- Non-primary button (`button: 2`) is ignored.
- Drag sequence: pointerdown(row 2) → pointermove with `clientY` over
  row 6 → selection spans 2–6 with head 6.
- pointermove with `clientY` below the container rect clamps to the
  bottom visible row; above clamps to the top.
- pointermove with a different `pointerId` does not extend.
- After pointerup, further pointermoves do not extend.

**`useClickOutsideDeselect.test.ts`**:

- Outside pointerdown clears an existing selection.
- Pointerdown whose path contains a `.tracker-container` element keeps it.
- Pointerdown whose path contains an `aria-modal="true"` element keeps it.
- No-op (no `clear` call) when no valid selection exists.
- Listener is removed on unmount (pointerdown after unmount → no clear).

**Browser verification** (mandatory; dev:obs, throwaway session, clean
console, close browser):

- Drag down and up in the focused layout and the overview grid.
- Drag horizontally out of the step column mid-drag — selection keeps
  following vertical position (capture).
- Drag past the bottom edge at pattern length 32 — edge auto-scroll.
- Shift+drag extends from the existing anchor.
- Plain click (no movement) still places; shift+click still extends.
- Click a knob inside a Tracker card — selection survives.
- Click empty page space — selection clears.
- Open PRESETS, click inside the dialog — selection survives; close it.
- After a drag-selection: arrows, Meta+c / Meta+v, Escape all still work.

## Risks / notes

- jsdom implements neither pointer capture nor layout — the `try/catch`
  around `setPointerCapture`/`releasePointerCapture` and the geometry
  mocks in tests are load-bearing, not decoration.
- `composedPath()` is used (not `e.target.closest`) so the check also
  works across any future shadow-DOM boundaries and retargeted events.
- The cursor auto-scroll watcher (`Tracker.vue`, added by the keyboard
  feature) is reused untouched; drag edge auto-scroll emerges from
  clamping to the visible rect. If that watcher's `patternLength > 16`
  gate ever changes, drag edge-scroll inherits the change automatically.
