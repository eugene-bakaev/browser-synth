# Drag-Select + Click-Outside Deselect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drag-select (mousedown on a step cell + vertical drag live-extends the selection) and click-outside deselect (press outside every Tracker card clears the selection) to the existing step-row selection.

**Architecture:** Pointer Events with `setPointerCapture` on the scrollable `.tracker-steps` container (capture-to-origin-track, no window listeners, no teardown bookkeeping) + geometry-based row lookup (vertical offset ÷ uniform row height, so horizontal pointer position is irrelevant). Click-outside is a capture-phase `document` `pointerdown` listener in a new composable that keys off `composedPath()` — it never preventDefaults, so it can't swallow or race anything. Zero changes to the selection store, keyboard system, shared, or server.

**Tech Stack:** Vue 3 `<script setup>`, Pinia setup stores, Vitest + jsdom.

**Source spec:** `docs/superpowers/specs/2026-07-10-drag-select-design.md` (approved, commit `4e3e9eb`).

## Global Constraints

- Branch: `feat/drag-select` (already checked out, off `ee660ae`). Never commit to main.
- **Zero store API changes** — only `place`, `extendTo`, `clear`, `validSelection`, `isSelected` from `stores/selection.ts` may be used, as-is.
- **Zero keyboard-system, shared, or server changes.**
- Drag never hops tracks: all `place`/`extendTo` calls use `props.trackId`.
- "Outside" = outside every `.tracker-container` AND outside any `[aria-modal="true"]` element (modal presses keep the selection, matching KeyboardService's modal stand-down).
- No `touch-action` CSS changes — touch scrolling on the step column must keep working; `pointercancel` just ends a drag.
- The click-outside handler must never call `preventDefault()` or `stopPropagation()`.
- Selection moves to press-time: `.col-step` uses `@pointerdown`; the old `@click` handler `onStepCellClick` is deleted (not kept alongside).
- Stage only named files (`git add <paths>`); NEVER `git add -A`/`-u`. Never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir`
- Run test commands from the repo root: `/Users/eugenebakaev/Development/browser-synth`.

---

### Task 1: Drag-select in Tracker.vue

**Files:**
- Modify: `packages/client/src/components/Tracker.vue` (template lines ~82-90 container, ~114 `.col-step`; script lines ~303-310 selection block)
- Test: `packages/client/src/components/Tracker.test.ts` (replace the click/shift+click test at ~line 217; add drag tests)

**Interfaces:**
- Consumes (all existing, unchanged): `useSelectionStore()` instance `selection` with `place(trackId: number, row: number)`, `extendTo(trackId: number, row: number)`, `validSelection`; `props.trackId: number`, `props.patternLength: number`; `stepsEl = ref<HTMLElement | null>(null)` (already bound to `.tracker-steps` via `ref="stepsEl"`); the cursor auto-scroll watcher on `cursorRow` (untouched — it provides drag edge auto-scroll for free).
- Produces: template handlers `onStepPointerDown(e: PointerEvent, row: number)`, `onStepsPointerMove(e: PointerEvent)`, `onStepsPointerUp(e: PointerEvent)`. Nothing outside Tracker.vue consumes these.

**Context notes for the implementer:**
- `.tracker-steps`'s element children are exactly the step rows (the header row lives outside it), so `el.children[0]` is the first `.step-row` — the existing `scrollRowIntoView` already relies on this.
- jsdom implements neither `PointerEvent` nor pointer capture. Tests dispatch `MouseEvent`s with type `'pointerdown'`/`'pointermove'`/`'pointerup'` and a defined `pointerId`; the implementation's `try/catch` around `setPointerCapture`/`releasePointerCapture` is what lets it run under jsdom — do not remove it.
- The existing test harness `mountTrackerWithPinia` (Tracker.test.ts ~line 48) already heals the project store so `validSelection` accepts placements. Reuse it.

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/components/Tracker.test.ts`, add these two helpers near the top of the `describe('step selection UI', ...)` block (after the existing harness functions):

```ts
// jsdom has no PointerEvent; a MouseEvent with the pointer type name and a
// defined pointerId is what the component's handlers actually read.
function ptr(type: string, init: MouseEventInit & { pointerId?: number } = {}): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
  return e;
}

// jsdom has no layout: pin the container rect and the first row's height so
// the geometry row lookup (clientY → row) has real numbers to work with.
// rect spans rows 0..15 (16 rows × 20px), top at y=0.
function mockStepsGeometry(el: HTMLElement, rowHeight = 20, visibleRows = 16): HTMLElement {
  const steps = el.querySelector('.tracker-steps') as HTMLElement;
  vi.spyOn(steps, 'getBoundingClientRect').mockReturnValue({
    top: 0, bottom: rowHeight * visibleRows, left: 0, right: 100,
    width: 100, height: rowHeight * visibleRows, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(steps.children[0], 'offsetHeight', { value: rowHeight, configurable: true });
  return steps;
}
```

**Replace** the existing test `'click on a step-number cell places the selection; shift+click extends it'` (~line 217) with:

```ts
it('pointerdown on a step-number cell places the selection; shift+pointerdown extends it', async () => {
  const { el, selection } = mountTrackerWithPinia({ trackId: 2 });
  const cells = el.querySelectorAll('.step-row .col-step');
  cells[3].dispatchEvent(ptr('pointerdown'));
  await nextTick();
  expect(selection.validSelection).toEqual({ trackId: 2, start: 3, end: 3, head: 3 });
  cells[6].dispatchEvent(ptr('pointerdown', { shiftKey: true }));
  await nextTick();
  expect(selection.validSelection).toEqual({ trackId: 2, start: 3, end: 6, head: 6 });
});
```

**Add** these new tests in the same describe block:

```ts
it('non-primary-button pointerdown does not touch the selection', async () => {
  const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
  el.querySelectorAll('.step-row .col-step')[3].dispatchEvent(ptr('pointerdown', { button: 2 }));
  await nextTick();
  expect(selection.validSelection).toBeNull();
});

it('dragging from row 2 down over row 6 extends the selection to 2–6', async () => {
  const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
  const steps = mockStepsGeometry(el);
  el.querySelectorAll('.step-row .col-step')[2].dispatchEvent(ptr('pointerdown'));
  steps.dispatchEvent(ptr('pointermove', { clientY: 6 * 20 + 10 })); // middle of row 6
  await nextTick();
  expect(selection.validSelection).toEqual({ trackId: 0, start: 2, end: 6, head: 6 });
});

it('drag clamps to the edge rows when the pointer leaves the container vertically', async () => {
  const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
  const steps = mockStepsGeometry(el);
  el.querySelectorAll('.step-row .col-step')[4].dispatchEvent(ptr('pointerdown'));
  steps.dispatchEvent(ptr('pointermove', { clientY: 9999 })); // far below → bottom visible row
  await nextTick();
  expect(selection.validSelection).toEqual({ trackId: 0, start: 4, end: 15, head: 15 });
  steps.dispatchEvent(ptr('pointermove', { clientY: -50 })); // far above → top row
  await nextTick();
  expect(selection.validSelection).toEqual({ trackId: 0, start: 0, end: 4, head: 0 });
});

it('pointermove with a different pointerId does not extend', async () => {
  const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
  const steps = mockStepsGeometry(el);
  el.querySelectorAll('.step-row .col-step')[2].dispatchEvent(ptr('pointerdown', { pointerId: 1 }));
  steps.dispatchEvent(ptr('pointermove', { pointerId: 99, clientY: 6 * 20 + 10 }));
  await nextTick();
  expect(selection.validSelection).toEqual({ trackId: 0, start: 2, end: 2, head: 2 });
});

it('after pointerup, further pointermoves do not extend', async () => {
  const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
  const steps = mockStepsGeometry(el);
  el.querySelectorAll('.step-row .col-step')[2].dispatchEvent(ptr('pointerdown'));
  steps.dispatchEvent(ptr('pointerup'));
  steps.dispatchEvent(ptr('pointermove', { clientY: 6 * 20 + 10 }));
  await nextTick();
  expect(selection.validSelection).toEqual({ trackId: 0, start: 2, end: 2, head: 2 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @fiddle/client -- Tracker.test.ts`
Expected: the replaced test and all 5 new tests FAIL (the component still binds `@click`, no pointer handlers exist). Pre-existing tests still pass.

- [ ] **Step 3: Implement the pointer handlers in Tracker.vue**

Template — change line ~114 from:

```html
<div class="col-step" @click="onStepCellClick($event, i)">{{ i.toString().padStart(2, '0') }}</div>
```

to:

```html
<div class="col-step" @pointerdown="onStepPointerDown($event, i)">{{ i.toString().padStart(2, '0') }}</div>
```

Template — add three listeners to the `.tracker-steps` container div (~lines 82-90), after `@touchmove="markManualScroll"`:

```html
      @pointermove="onStepsPointerMove"
      @pointerup="onStepsPointerUp"
      @pointercancel="onStepsPointerUp"
```

Script — replace the selection block (the comment at ~line 303 plus `onStepCellClick`, lines ~303-310) with:

```ts
// Row selection (keyboard copy/cut/clear/paste). The step-number cell is the
// selection handle: press places, shift+press extends, and dragging while
// the button is held live-extends. Pointer capture on the steps container
// keeps the drag alive when the pointer leaves the narrow step column (or
// the window); rows come from vertical geometry, not hit-testing, so the
// pointer's horizontal position never matters. Local UI state only.
const selection = useSelectionStore();

let dragPointerId: number | null = null;
let lastDragRow: number | null = null;

function onStepPointerDown(e: PointerEvent, row: number): void {
  if (e.button !== 0) return;
  e.preventDefault(); // no native text-selection/focus side effects
  if (e.shiftKey) selection.extendTo(props.trackId, row);
  else selection.place(props.trackId, row);
  const el = stepsEl.value;
  if (!el) return;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // jsdom and exotic embeds don't implement pointer capture; the drag
    // still works there for pointers that stay over the container.
  }
  dragPointerId = e.pointerId;
  lastDragRow = row;
}

// clientY → step row: clamp to the container's visible rect (so dragging
// past an edge selects the edge row — the cursorRow auto-scroll watcher
// then scrolls the next row into view, giving edge auto-scroll for free),
// add scrollTop, divide by the uniform row height.
function rowUnderPointer(e: PointerEvent): number | null {
  const el = stepsEl.value;
  if (!el) return null;
  const first = el.children[0] as HTMLElement | undefined;
  const rowHeight = first?.offsetHeight ?? 0;
  if (rowHeight <= 0) return null;
  const rect = el.getBoundingClientRect();
  const y = Math.min(Math.max(e.clientY, rect.top), rect.bottom - 1) - rect.top + el.scrollTop;
  return Math.min(Math.max(Math.floor(y / rowHeight), 0), props.patternLength - 1);
}

function onStepsPointerMove(e: PointerEvent): void {
  if (dragPointerId === null || e.pointerId !== dragPointerId) return;
  const row = rowUnderPointer(e);
  if (row === null || row === lastDragRow) return;
  lastDragRow = row;
  selection.extendTo(props.trackId, row);
}

function onStepsPointerUp(e: PointerEvent): void {
  if (dragPointerId === null || e.pointerId !== dragPointerId) return;
  try {
    stepsEl.value?.releasePointerCapture(e.pointerId);
  } catch {
    // browsers release implicitly on pointerup; jsdom has no capture at all
  }
  dragPointerId = null;
  lastDragRow = null;
}
```

Notes:
- `dragPointerId`/`lastDragRow` are plain `let`s, not refs — nothing in the template reads them (same pattern as the existing `editingInSteps` flag).
- `stepsEl` is declared further down in the file (~line 340, playhead auto-follow section). `<script setup>` hoists `const` declarations for template use, and the handlers only dereference it at event time — do NOT move or redeclare it.
- Delete `onStepCellClick` entirely; nothing else references it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @fiddle/client -- Tracker.test.ts`
Expected: PASS — all tests in the file, including the pre-existing playhead/auto-scroll/selection-class tests.

- [ ] **Step 5: Run the full client suite + typecheck**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client`
Expected: all client tests pass (832 + the net-new ones; the replaced click test keeps the count moving by +5), vue-tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/Tracker.vue packages/client/src/components/Tracker.test.ts
git commit -m "feat(client): drag-select step rows via pointer capture

Press on a step-number cell places (shift+press extends) at pointerdown;
dragging while held live-extends the selection over the rows under the
pointer's vertical position, captured to the origin track and clamped to
the pattern window. Geometry-based row lookup + setPointerCapture on
.tracker-steps: no window listeners, no teardown bookkeeping, release
outside the window still ends the drag. Edge auto-scroll falls out of the
existing cursorRow watcher.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 2: Click-outside deselect composable + StudioView registration

**Files:**
- Create: `packages/client/src/composables/useClickOutsideDeselect.ts`
- Create: `packages/client/src/composables/useClickOutsideDeselect.test.ts`
- Modify: `packages/client/src/views/StudioView.vue` (~line 353 imports, ~line 391 after the `useKeyboardCommand(...)` call)

**Interfaces:**
- Consumes: `useSelectionStore` from `../stores/selection` — specifically `validSelection` (read) and `clear()` (the only mutation). In StudioView, the already-existing local `const selectionStore = useSelectionStore();` (~line 383).
- Produces: `export function useClickOutsideDeselect(selection: SelectionStore): void` where `type SelectionStore = ReturnType<typeof useSelectionStore>`. Must be called during component `setup()` (it registers `onMounted`/`onBeforeUnmount` hooks).

**Context notes for the implementer:**
- Tracker cards have root class `tracker-container` (Tracker.vue line 2). All modals render inside `<div class="dialog" role="dialog" aria-modal="true">` (BaseModal.vue).
- The design mandates `composedPath()` (not `target.closest`) and a **capture-phase** listener on `document`, and forbids `preventDefault`/`stopPropagation` in the handler.
- jsdom supports `composedPath()` during dispatch of bubbling events — dispatch test events with `bubbles: true`.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/composables/useClickOutsideDeselect.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createPinia } from 'pinia';
import { useSelectionStore } from '../stores/selection';
import { useProjectStore } from '../stores/project';
import { useClickOutsideDeselect } from './useClickOutsideDeselect';

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
// store so validSelection accepts placements (it validates against live
// project state), and places a selection on track 0 rows 2..2.
function mountHarness(): { selection: ReturnType<typeof useSelectionStore> } {
  host = document.createElement('div');
  document.body.appendChild(host);
  const pinia = createPinia();
  const Comp = defineComponent({
    setup() {
      const selection = useSelectionStore();
      useClickOutsideDeselect(selection);
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

function down(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
}

describe('useClickOutsideDeselect', () => {
  it('clears the selection on a pointerdown outside every tracker card', () => {
    const { selection } = mountHarness();
    down(document.body);
    expect(selection.validSelection).toBeNull();
  });

  it('keeps the selection when the press lands inside a .tracker-container', () => {
    const { selection } = mountHarness();
    const card = document.createElement('div');
    card.className = 'tracker-container';
    const knob = document.createElement('button');
    card.appendChild(knob);
    document.body.appendChild(card);
    down(knob);
    expect(selection.validSelection).not.toBeNull();
  });

  it('keeps the selection when the press lands inside an aria-modal dialog', () => {
    const { selection } = mountHarness();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const btn = document.createElement('button');
    dialog.appendChild(btn);
    document.body.appendChild(dialog);
    down(btn);
    expect(selection.validSelection).not.toBeNull();
  });

  it('does not call clear() when no valid selection exists', () => {
    const { selection } = mountHarness();
    selection.clear();
    const spy = vi.spyOn(selection, 'clear');
    down(document.body);
    expect(spy).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const { selection } = mountHarness();
    app!.unmount();
    app = null; // afterEach must not double-unmount
    down(document.body);
    expect(selection.validSelection).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @fiddle/client -- useClickOutsideDeselect.test.ts`
Expected: FAIL — cannot resolve `./useClickOutsideDeselect`.

- [ ] **Step 3: Implement the composable**

Create `packages/client/src/composables/useClickOutsideDeselect.ts`:

```ts
import { onMounted, onBeforeUnmount } from 'vue';
import type { useSelectionStore } from '../stores/selection';

type SelectionStore = ReturnType<typeof useSelectionStore>;

// Clears the step selection when the user presses the mouse outside every
// Tracker card — the mouse counterpart of Escape (tracker.deselect).
//
// Capture-phase document pointerdown: runs before any click handler and
// never preventDefaults/stopPropagations, so it cannot swallow or race the
// .col-step handlers (a press on another track's step cell re-places the
// selection through its own handler; this one sees .tracker-container in
// the path and stands down). Keying off pointerDOWN means a drag that ENDS
// outside a tracker never clears — its down happened inside a card. Presses
// inside an open [aria-modal="true"] dialog also keep the selection,
// consistent with KeyboardService's modal stand-down.
export function useClickOutsideDeselect(selection: SelectionStore): void {
  const onPointerDown = (e: Event): void => {
    if (selection.validSelection === null) return;
    for (const node of e.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (node.classList.contains('tracker-container')) return;
      if (node.getAttribute('aria-modal') === 'true') return;
    }
    selection.clear();
  };
  onMounted(() => document.addEventListener('pointerdown', onPointerDown, true));
  onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown, true));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @fiddle/client -- useClickOutsideDeselect.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Register in StudioView.vue**

Add the import after the existing `useKeyboardCommand` import (~line 353):

```ts
import { useClickOutsideDeselect } from '../composables/useClickOutsideDeselect';
```

Add the call directly after the `useKeyboardCommand(synth.keyboard, createTrackerCommands({ ... }));` block (~line 391):

```ts
// Press outside every Tracker card clears the step selection (mouse
// counterpart of Escape / tracker.deselect). Modal presses stand down.
useClickOutsideDeselect(selectionStore);
```

`selectionStore` already exists at ~line 383 — do not create a second store instance.

- [ ] **Step 6: Run the full client gate**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client && npm run build -w @fiddle/client`
Expected: all tests pass, vue-tsc clean, vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/composables/useClickOutsideDeselect.ts packages/client/src/composables/useClickOutsideDeselect.test.ts packages/client/src/views/StudioView.vue
git commit -m "feat(client): click outside a tracker card clears the step selection

Capture-phase document pointerdown in a new useClickOutsideDeselect
composable (registered by StudioView): stands down when composedPath
contains a .tracker-container or aria-modal element, otherwise clears.
Never preventDefaults, so it can't swallow or race the step-cell
handlers; keying off pointerdown means drags that end outside a card
keep their selection.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

## After all tasks (controller, not a task)

1. Full gate from repo root: `npm run test -w @fiddle/shared && npm run test -w @fiddle/client && npm run test -w @fiddle/server && npm run typecheck && npm run build -w @fiddle/client`.
2. Final whole-branch review (most capable model) over `git merge-base main HEAD`..HEAD.
3. Mandatory browser verification on `npm run dev:obs` (NEVER `npm run dev`), throwaway session, per the spec's checklist: drag down/up in focused + overview; drag horizontally out of the column (capture); drag past the bottom edge at length 32 (edge auto-scroll); shift+drag; plain click/shift+click still work; knob click inside a card keeps selection; empty-space click clears; PRESETS dialog click keeps selection; arrows/Meta+c/Meta+v/Escape still work after a drag. Clean console (favicon 404 + local `/api/presets` 500 tolerated as pre-existing). Close the browser session.
4. Present finishing options (merge / PR / keep / discard) — default to keeping the branch for user verification.
