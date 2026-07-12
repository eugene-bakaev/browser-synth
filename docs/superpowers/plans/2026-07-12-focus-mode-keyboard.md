# Focus-Mode Keyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make focusing an input a value-editing mode — it clears the step selection — and let undo/redo fire regardless of what is focused.

**Architecture:** Two independent client-local changes plus a small shared-helper extraction. (1) `isEditableTarget` moves to its own leaf module so a composable can reuse it. (2) A new `focusin` composable clears the selection when an editable takes focus, closing the seam `useClickOutsideDeselect` leaves inside `.tracker-container`. (3) `KeyboardCommand` gains a `focusIndependent` flag; the editable guard becomes a per-command filter instead of a blanket early-return, and undo/redo opt in.

**Tech Stack:** Vue 3, TypeScript, Pinia, Vitest (jsdom environment).

## Global Constraints

- Client-local only: NO changes to `@fiddle/shared` or `@fiddle/server`, no new UI, no binding-table changes.
- The **modal guard stays a hard early-return** — `focusIndependent` commands are still suppressed while an `[aria-modal="true"]` element is in the document.
- The editable guard must remain in force for every command EXCEPT the ones that opt in via `focusIndependent`, so plain keys (`m`, arrows, delete) are never swallowed from a focused field.
- Selection is LOCAL-ONLY state; `selection.clear()` (`stores/selection.ts:161`) is the only mutation this feature performs.
- Tests use `// @vitest-environment jsdom` and Vitest (`describe`/`it`/`expect`/`vi`). Run the client suite from repo root with `npm test -w @fiddle/client`.

---

## File Structure

- `packages/client/src/keyboard/isEditableTarget.ts` — **new leaf module.** Owns the `isEditableTarget` predicate + its jsdom-fallback comment. One responsibility: classify an EventTarget as editable.
- `packages/client/src/keyboard/isEditableTarget.test.ts` — **new.** Direct unit coverage for the predicate.
- `packages/client/src/keyboard/KeyboardService.ts` — **modified.** Import `isEditableTarget` from the leaf and re-export it (drop the inline definition); add the `focusIndependent` flag; turn the editable guard into a filter.
- `packages/client/src/keyboard/KeyboardService.test.ts` — **modified.** Add `focusIndependent` coverage.
- `packages/client/src/composables/useDeselectOnInputFocus.ts` — **new.** The `focusin` deselect composable.
- `packages/client/src/composables/useDeselectOnInputFocus.test.ts` — **new.** Mirrors `useClickOutsideDeselect.test.ts`.
- `packages/client/src/views/StudioView.vue` — **modified.** Import + call the new composable next to `useClickOutsideDeselect`.
- `packages/client/src/app/AppRuntime.ts` — **modified.** Add `focusIndependent: true` to the two undo/redo registrations (`AppRuntime.ts:81-88`).

---

## Task 1: Extract `isEditableTarget` into a leaf module

Pure refactor, no behavior change. Enables the composable (Task 2) to reuse the predicate without importing the whole `KeyboardService`. There are currently no external importers of `isEditableTarget`; the re-export is forward-compat.

**Files:**
- Create: `packages/client/src/keyboard/isEditableTarget.ts`
- Create (test): `packages/client/src/keyboard/isEditableTarget.test.ts`
- Modify: `packages/client/src/keyboard/KeyboardService.ts:48-57` (replace inline definition with import + re-export)

**Interfaces:**
- Produces: `isEditableTarget(t: EventTarget | null): boolean` — exported from `keyboard/isEditableTarget.ts` and re-exported from `keyboard/KeyboardService.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/keyboard/isEditableTarget.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isEditableTarget } from './isEditableTarget';

describe('isEditableTarget', () => {
  it('is true for input, textarea, and select elements', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect(isEditableTarget(div)).toBe(true);
  });

  it('is false for a plain div and for null', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/client -- isEditableTarget`
Expected: FAIL — cannot resolve `./isEditableTarget` (module does not exist yet).

- [ ] **Step 3: Create the leaf module**

Create `packages/client/src/keyboard/isEditableTarget.ts` (verbatim from the current `KeyboardService.ts:48-57`):

```ts
// Classifies an event target as an editable field — the keyboard system's
// editable guard and the focus-deselect composable both key off this.
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // isContentEditable is the correct (inherited/computed) check in real
  // browsers. jsdom (used by this file's tests) doesn't implement it, so
  // fall back to the raw property/attribute value — a no-op in real
  // browsers, where isContentEditable is already true whenever this is.
  return t.isContentEditable || t.contentEditable === 'true';
}
```

- [ ] **Step 4: Replace the inline definition in `KeyboardService.ts` with an import + re-export**

In `packages/client/src/keyboard/KeyboardService.ts`, delete the whole inline `export function isEditableTarget(...) { ... }` block (currently lines 48-57) and add an import near the other imports at the top (after the `import { KEY_BINDINGS }` line) plus a re-export:

```ts
import { isEditableTarget } from './isEditableTarget';

// Re-exported so existing/future importers can keep using it from here.
export { isEditableTarget };
```

Leave every use of `isEditableTarget` inside the file (in `handleKeydown`) untouched.

- [ ] **Step 5: Run the new test AND the existing KeyboardService test to verify both pass**

Run: `npm test -w @fiddle/client -- isEditableTarget KeyboardService`
Expected: PASS — the new predicate tests pass and the existing editable-guard test still passes via the re-export.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/keyboard/isEditableTarget.ts packages/client/src/keyboard/isEditableTarget.test.ts packages/client/src/keyboard/KeyboardService.ts
git commit -m "refactor(client): extract isEditableTarget into its own leaf module"
```

---

## Task 2: `useDeselectOnInputFocus` composable + wire into StudioView

The `focusin` counterpart to `useClickOutsideDeselect`. Clears the selection when an editable takes focus, wherever it lives, so focusing a grid input no longer leaves a dead selection.

**Files:**
- Create: `packages/client/src/composables/useDeselectOnInputFocus.ts`
- Create (test): `packages/client/src/composables/useDeselectOnInputFocus.test.ts`
- Modify: `packages/client/src/views/StudioView.vue:354` (import) and `:396` (call)

**Interfaces:**
- Consumes: `isEditableTarget` from `keyboard/isEditableTarget` (Task 1); `selection.validSelection` and `selection.clear()` from the selection store.
- Produces: `useDeselectOnInputFocus(selection: SelectionStore): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/composables/useDeselectOnInputFocus.test.ts` (mirrors `useClickOutsideDeselect.test.ts`):

```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createPinia } from 'pinia';
import { useSelectionStore } from '../stores/selection';
import { useProjectStore } from '../stores/project';
import { useDeselectOnInputFocus } from './useDeselectOnInputFocus';

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  document.body.innerHTML = '';
  app = null;
  host = null;
});

// Mounts a bare component that registers the composable, heals the project
// store so validSelection accepts placements, and places a selection on
// track 0 row 2.
function mountHarness(): { selection: ReturnType<typeof useSelectionStore> } {
  host = document.createElement('div');
  document.body.appendChild(host);
  const pinia = createPinia();
  const Comp = defineComponent({
    setup() {
      const selection = useSelectionStore();
      useDeselectOnInputFocus(selection);
      return () => h('div');
    },
  });
  app = createApp(Comp);
  app.use(pinia);
  app.mount(host);
  const projectStore = useProjectStore(pinia);
  projectStore.project.tracks[0].enabled = true;
  projectStore.project.tracks[0].patternLength = 16;
  const selection = useSelectionStore(pinia);
  selection.place(0, 2);
  expect(selection.validSelection).not.toBeNull();
  return { selection };
}

function focus(el: HTMLElement): void {
  document.body.appendChild(el);
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

describe('useDeselectOnInputFocus', () => {
  it('clears the selection when an input takes focus', () => {
    const { selection } = mountHarness();
    focus(document.createElement('input'));
    expect(selection.validSelection).toBeNull();
  });

  it('clears the selection when a select takes focus', () => {
    const { selection } = mountHarness();
    focus(document.createElement('select'));
    expect(selection.validSelection).toBeNull();
  });

  it('keeps the selection when focus lands on a non-editable element', () => {
    const { selection } = mountHarness();
    const step = document.createElement('div');
    step.className = 'col-step';
    focus(step);
    expect(selection.validSelection).not.toBeNull();
  });

  it('keeps the selection when the focused input is inside an aria-modal dialog', () => {
    const { selection } = mountHarness();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(selection.validSelection).not.toBeNull();
  });

  it('does not call clear() when no valid selection exists', () => {
    const { selection } = mountHarness();
    selection.clear();
    const spy = vi.spyOn(selection, 'clear');
    focus(document.createElement('input'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const { selection } = mountHarness();
    app!.unmount();
    app = null; // afterEach must not double-unmount
    focus(document.createElement('input'));
    expect(selection.validSelection).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/client -- useDeselectOnInputFocus`
Expected: FAIL — cannot resolve `./useDeselectOnInputFocus` (module does not exist yet).

- [ ] **Step 3: Write the composable**

Create `packages/client/src/composables/useDeselectOnInputFocus.ts`:

```ts
import { onMounted, onBeforeUnmount } from 'vue';
import type { useSelectionStore } from '../stores/selection';
import { isEditableTarget } from '../keyboard/isEditableTarget';

type SelectionStore = ReturnType<typeof useSelectionStore>;

// Clears the step selection the moment an editable field (input / select /
// textarea / contenteditable) takes focus — the "focus is a value-editing
// mode" rule. Companion to useClickOutsideDeselect: that one keys off
// pointerdown and stands down inside .tracker-container, so focusing an input
// INSIDE a tracker card never cleared the selection. focusin fires wherever
// the field lives and closes that seam. Stands down inside an open
// [aria-modal="true"] dialog, consistent with the pointer deselect. Plain
// .col-step selection clicks are unaffected — those targets are not editable.
export function useDeselectOnInputFocus(selection: SelectionStore): void {
  const onFocusIn = (e: Event): void => {
    if (selection.validSelection === null) return;
    if (!isEditableTarget(e.target)) return;
    for (const node of e.composedPath()) {
      if (node instanceof Element && node.getAttribute('aria-modal') === 'true') return;
    }
    selection.clear();
  };
  onMounted(() => document.addEventListener('focusin', onFocusIn, true));
  onBeforeUnmount(() => document.removeEventListener('focusin', onFocusIn, true));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/client -- useDeselectOnInputFocus`
Expected: PASS — all six cases green.

- [ ] **Step 5: Wire the composable into StudioView**

In `packages/client/src/views/StudioView.vue`, add the import directly below the existing `useClickOutsideDeselect` import (line 354):

```ts
import { useDeselectOnInputFocus } from '../composables/useDeselectOnInputFocus';
```

And add the call directly below the existing `useClickOutsideDeselect(selectionStore);` call (line 396):

```ts
useDeselectOnInputFocus(selectionStore);
```

- [ ] **Step 6: Run the client typecheck + build to confirm the wiring compiles**

Run: `npm run build -w @fiddle/client`
Expected: PASS — vue-tsc + build succeed with the new import/call.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/composables/useDeselectOnInputFocus.ts packages/client/src/composables/useDeselectOnInputFocus.test.ts packages/client/src/views/StudioView.vue
git commit -m "feat(client): clear step selection when an input takes focus"
```

---

## Task 3: `focusIndependent` commands — undo/redo fire regardless of focus

Turn the editable guard from a blanket early-return into a per-command filter, and opt undo/redo in.

**Files:**
- Modify: `packages/client/src/keyboard/KeyboardService.ts` (`KeyboardCommand` interface + `handleKeydown` guard)
- Modify (test): `packages/client/src/keyboard/KeyboardService.test.ts`
- Modify: `packages/client/src/app/AppRuntime.ts:81-88` (undo/redo registrations)

**Interfaces:**
- Consumes: `isEditableTarget` (already imported in `KeyboardService.ts` after Task 1).
- Produces: `KeyboardCommand.focusIndependent?: boolean` — when true the command dispatches even while an editable target is focused (still suppressed under an open modal).

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/keyboard/KeyboardService.test.ts`, inside the existing `describe('KeyboardService dispatch', ...)` block (so the `svc`, `cmd`, `kev` helpers are in scope):

```ts
  it('focusIndependent: dispatches even when an editable target is focused', () => {
    const s = svc();
    const guarded = cmd({ id: 'test.copy' });
    const global = cmd({ id: 'test.globalUp', context: 'global', focusIndependent: true });
    s.register(guarded);
    s.register(global);
    const input = document.createElement('input');
    document.body.appendChild(input);

    const e1 = kev('c', { ctrlKey: true, bubbles: true });
    input.dispatchEvent(e1); // sets e1.target to the input
    s.handleKeydown(e1);
    expect(guarded.run).not.toHaveBeenCalled(); // non-flagged stays suppressed

    const e2 = kev('ArrowUp', { bubbles: true });
    input.dispatchEvent(e2);
    s.handleKeydown(e2);
    expect(global.run).toHaveBeenCalledTimes(1); // flagged fires through the field
    expect(e2.defaultPrevented).toBe(true);

    input.remove();
  });

  it('focusIndependent commands are still suppressed while a modal is open', () => {
    const s = svc();
    const global = cmd({ id: 'test.globalUp', context: 'global', focusIndependent: true });
    s.register(global);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    const e = kev('ArrowUp');
    s.handleKeydown(e);
    expect(global.run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    modal.remove();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- KeyboardService`
Expected: FAIL — `focusIndependent` is not a known property (type error) and/or the flagged command does not fire because the editable guard still returns early.

- [ ] **Step 3: Add the `focusIndependent` flag to the `KeyboardCommand` interface**

In `packages/client/src/keyboard/KeyboardService.ts`, add to the `KeyboardCommand` interface (next to `allowRepeat`):

```ts
  /** Default false. When true, the command fires even while an editable
   *  target is focused (still suppressed under an open modal). Reserved for
   *  truly app-global commands (undo/redo). */
  focusIndependent?: boolean;
```

- [ ] **Step 4: Turn the editable guard into a per-command filter**

In `handleKeydown`, replace the editable-guard early-return (currently `if (isEditableTarget(e.target)) return;`) and fold the check into the match filter. The method becomes:

```ts
  handleKeydown(e: KeyboardEvent): void {
    // Guard 1b — modal dialog open: a modal is a stronger mode, so the whole
    // command system (including focusIndependent commands) stands down while
    // one is open. Left completely untouched — no preventDefault.
    if (isModalOpen()) return;
    // Guard 1 — editable target: typing in a field NEVER triggers commands,
    // EXCEPT commands that opt in via focusIndependent (undo/redo). The guard
    // must stay for everything else so plain keys are not swallowed from the
    // field. Component-local key handling (e.g. Enter in TrackNameEditor) is
    // untouched: we listen in the bubble phase.
    const editable = isEditableTarget(e.target);
    const matches = this.registrations.filter((r) =>
      // Guard 2 — key auto-repeat, unless the command opted in.
      (!e.repeat || r.cmd.allowRepeat === true)
      && (!editable || r.cmd.focusIndependent === true)
      && r.descriptors.some((d) => matchesEvent(d, e, this.platform)),
    );
    matches.sort((a, b) => CONTEXT_PRIORITY[b.cmd.context] - CONTEXT_PRIORITY[a.cmd.context]);
    const winner = matches.find((r) => r.cmd.isEnabled?.() !== false);
    if (!winner) return; // untouched: disabled mod+c still lets the browser copy page text
    e.preventDefault();
    winner.cmd.run(e);
  }
```

(Also remove or update the now-stale leading comment block above `handleKeydown` that describes Guard 1 as an unconditional return, so the code and comments agree.)

- [ ] **Step 5: Run the KeyboardService tests to verify they pass**

Run: `npm test -w @fiddle/client -- KeyboardService`
Expected: PASS — the two new tests pass and every existing guard test (editable, modal, repeat, priority, conflict) still passes.

- [ ] **Step 6: Opt undo/redo in**

In `packages/client/src/app/AppRuntime.ts`, add `focusIndependent: true` to both registrations (lines 81-88):

```ts
  keyboard.register({
    id: 'global.undo', description: 'Undo last edit', context: 'global',
    allowRepeat: true, focusIndependent: true,
    isEnabled: () => history.canUndo(), run: () => history.undo(),
  });
  keyboard.register({
    id: 'global.redo', description: 'Redo last undone edit', context: 'global',
    allowRepeat: true, focusIndependent: true,
    isEnabled: () => history.canRedo(), run: () => history.redo(),
  });
```

- [ ] **Step 7: Run the full client suite + build to confirm nothing regressed**

Run: `npm test -w @fiddle/client && npm run build -w @fiddle/client`
Expected: PASS — full client test suite green, vue-tsc + build succeed.

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/keyboard/KeyboardService.ts packages/client/src/keyboard/KeyboardService.test.ts packages/client/src/app/AppRuntime.ts
git commit -m "feat(client): focusIndependent commands — undo/redo fire regardless of focus"
```

---

## Final verification (after all tasks)

- [ ] Run the whole gate from repo root: `npm test -w @fiddle/client && npm run build -w @fiddle/client` (client), plus `npm test -w @fiddle/shared && npm test -w @fiddle/server` to confirm no cross-package breakage (there should be none — no shared/server files changed).
- [ ] Browser-verify per AGENTS.md (`npm run dev:obs`, NOT `npm run dev`): make a step selection; click a note `<select>` → selection clears; with an input focused, `mod+z`/`mod+y` still undo/redo while `m`/`mod+x` do not fire; `mod+z` inside the rename box does app-undo; a modal open suppresses undo/redo. Confirm a clean console. Close the browser when done.

## Self-review notes

- **Spec coverage:** Component 1 → Task 2; Component 2 → Task 3; `isEditableTarget` extraction → Task 1. Modal-guard-stays-hard → Task 3 Step 4 + its second test. App-undo-wins → Task 3 Step 6 (undo/redo opt in) + browser check. Clear-on-focus stands down in aria-modal → Task 2 test case. Selecting untouched → Task 2 non-editable `.col-step` test case.
- **No shared/server changes:** confirmed — file list is entirely under `packages/client`.
- **Type consistency:** `focusIndependent?: boolean` is defined in Task 3 Step 3 and consumed in the same task's Step 4 filter and Step 6 registrations; `isEditableTarget(t: EventTarget | null): boolean` defined in Task 1 and consumed in Task 2's composable and Task 3's guard.
