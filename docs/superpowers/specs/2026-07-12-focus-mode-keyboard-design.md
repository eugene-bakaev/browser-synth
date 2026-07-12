# Focus-Mode Keyboard Design

**Date:** 2026-07-12
**Status:** Approved (user-reviewed design conversation)
**Branch:** feat/focus-mode-keyboard

## Problem

While any editable field is focused (a note/chord `<select>`, the pattern-length
input, a per-step LEN/OCT `StepNumberInput`, or a velocity range slider), the
entire keyboard command system stands down. `KeyboardService.handleKeydown`'s
editable guard (`isEditableTarget(e.target) → return`) is an unconditional early
return, so nothing fires: not mute, not cut/copy/paste, and — the sharpest
offender — not undo/redo. These fields keep focus after use (a `<select>` stays
focused after you pick an option; the length input after `@change`), so the user
is silently trapped with dead shortcuts until they click a neutral area.

## Model (user-approved)

**Focusing an input is a value-editing mode, distinct from grid manipulation.**
The two workflows are disjoint: you either have a step selection and act on it
(cut/copy/move/mute), or you are editing one field's value — there is no bulk
"apply this input to the whole selection" operation, so a selection can never be
*used* by an input edit. Therefore:

- **Focusing an editable clears the step selection.** A lingering selection you
  cannot act on is dead weight; clearing it makes the mode switch honest. Once
  cleared, the selection-ops are naturally inert, so their being blocked in a
  field is no longer a surprise ("no selection → nothing to cut").
- **undo/redo are app-global and fire regardless of focus.** They have nothing
  to do with what is focused; suppressing them behind a field is indefensible.

## Scope decisions (user-approved)

- **Clear-on-focus applies to any editable target** (INPUT / SELECT / TEXTAREA /
  contenteditable), anywhere in the app — not just the tracker grid. It stands
  down inside `[aria-modal="true"]`, matching the existing deselect rules.
- **Only `global.undo` and `global.redo` become focus-independent.** Every other
  command (mute, clipboard, cursor, move, clear, deselect) stays field-guarded
  exactly as today — the guard must remain so plain keys (`m`, arrows, delete)
  are not swallowed from the focused field.
- **App-undo wins over native text-undo.** In a genuine text/number field (the
  track-name rename box, the length inputs) `mod+z` now does app-undo and
  `preventDefault`s the field's native text-undo. Accepted: the rename box is a
  tiny transient editor where native undo is barely missed; app-undo everywhere
  is the stronger, more predictable model.
- **The modal guard stays a hard early-return.** A modal is a stronger mode, so
  undo/redo still stand down behind an open dialog. (The session-name field
  lives in a modal, so it is unaffected either way.)
- **Selecting is untouched.** Selection is made by clicking `.col-step` divs,
  which are not editable, so they never trip the focus listener.

## Architecture

Two independent, small changes.

### Component 1 — `useDeselectOnInputFocus(selection)`

New composable `packages/client/src/composables/useDeselectOnInputFocus.ts`,
the `focusin` counterpart to the existing `useClickOutsideDeselect`. Wired
alongside it in `StudioView.vue`.

```ts
export function useDeselectOnInputFocus(selection: SelectionStore): void {
  const onFocusIn = (e: FocusEvent): void => {
    if (selection.validSelection === null) return;
    if (!isEditableTarget(e.target)) return;
    // Stand down inside an open modal, consistent with the pointer deselect.
    for (const node of e.composedPath()) {
      if (node instanceof Element && node.getAttribute('aria-modal') === 'true') return;
    }
    selection.clear();
  };
  onMounted(() => document.addEventListener('focusin', onFocusIn, true));
  onBeforeUnmount(() => document.removeEventListener('focusin', onFocusIn, true));
}
```

Why `focusin` and not the existing pointerdown deselect: `useClickOutsideDeselect`
stands down inside `.tracker-container`, which is exactly why focusing an input
*inside* the grid never cleared the selection. `focusin` fires wherever the input
lives, closing that seam without touching the pointer path (so `.col-step`
selection clicks are unaffected — those targets are not editable).

`isEditableTarget` is currently a module export of `KeyboardService.ts`. To share
it without pulling the whole service into a composable, it moves to a tiny leaf
module `packages/client/src/keyboard/isEditableTarget.ts` (which owns the function
and its jsdom-fallback comment). `KeyboardService.ts` imports it from there and
re-exports it, so every existing importer — and its test — is unaffected.

### Component 2 — `focusIndependent` commands

`KeyboardCommand` gains an optional flag:

```ts
export interface KeyboardCommand {
  // ...existing fields...
  /** Default false. When true, the command fires even while an editable
   *  target is focused (still suppressed under an open modal). */
  focusIndependent?: boolean;
}
```

`handleKeydown` changes the editable guard from an unconditional early return
into a filter condition:

```ts
handleKeydown(e: KeyboardEvent): void {
  const editable = isEditableTarget(e.target);
  if (isModalOpen()) return; // modal stays a hard stand-down for everything
  const matches = this.registrations.filter((r) =>
    (!e.repeat || r.cmd.allowRepeat === true)
    && (!editable || r.cmd.focusIndependent === true)
    && r.descriptors.some((d) => matchesEvent(d, e, this.platform)),
  );
  // ...unchanged: context sort, isEnabled, preventDefault, run...
}
```

The two `global.undo` / `global.redo` command registrations (in the undo-history
wiring within `AppRuntime`) set `focusIndependent: true`. No binding-table change.

## Testing

- **`useDeselectOnInputFocus`** (new test): focusin on an INPUT/SELECT clears a
  live selection; focusin whose path includes `[aria-modal="true"]` does not;
  focusin on a non-editable element (a `.col-step` div) does not; no-op when
  there is no selection.
- **`KeyboardService`** (extend existing): a `focusIndependent` command fires
  when `isEditableTarget` is true; a non-flagged command does not; both are
  suppressed when a modal is open.
- **`isEditableTarget`** move: existing coverage continues to pass via the
  re-export; no behavior change.

## Non-goals

- No change to how selections are *made* (click / shift / cmd+click / drag).
- No migration of the modal/overlay Escape handlers into the keyboard system
  (still backlogged).
- No per-field preservation of native text-undo (explicitly rejected above).
- No new UI, no shared/server changes — entirely client-local.
