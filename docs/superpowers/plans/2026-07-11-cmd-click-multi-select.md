# Cmd+Click Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd/Ctrl+click toggles individual step rows in and out of the tracker selection, and every selection operation (mute, clear, copy/cut/paste, alt+arrow move) works on the resulting gapped selections.

**Architecture:** The selection store keeps today's `{trackId, anchor, head}` as the *active segment* and adds a `frozen: Set<number>` of rows committed by earlier Cmd+clicks; `validSelection` normalizes both into sorted `rows`/`ranges`. Every operation builds one span draft with gap rows copied through unchanged — `dispatchStepsRange`'s diff then emits only real changes. Sequenced expand→migrate→contract so each task's full client suite stays green: Task 1 adds the new producers alongside the old, Task 2 generalizes the store (keeping transitional `start`/`end` fields), Task 3 flips ops/commands/clipboard to the rows contract and deletes the old producers and fields, Task 4 wires the gesture.

**Tech Stack:** Vue 3 + Pinia + TypeScript, Vitest (jsdom), monorepo workspaces (@fiddle/client only — zero shared/server changes).

**Source spec:** `docs/superpowers/specs/2026-07-11-cmd-click-multi-select-design.md` (approved, committed `0ed18a1`). Branch: `feat/cmd-click-multi-select` off main `610603c`.

## Global Constraints

- **Zero changes** outside `packages/client`: no shared, server, KeyboardService, bindings, CSS, or composable changes.
- All step writes go through the existing `dispatchStepsRange` draft-diff-dispatch (every leaf carries priorValue; unchanged rows dispatch nothing).
- `rows` arrays handed to producers/ops are **sorted ascending, deduped, non-empty** — guaranteed by `validSelection`; producers may assume it.
- Rigid-constellation move clamp (USER DECIDED): up no-ops when `first === 0`, down when `last === patternLength - 1` — complete no-op, nothing dispatched.
- Transparent paste (USER DECIDED): `null` clipboard cells leave destination rows untouched; paste clips at the **pattern window** (`patternLength`), never the 64-slot buffer.
- Shift reshapes only the active segment; frozen rows persist (USER DECIDED).
- Contiguous selections must reproduce the merged `610603c` behavior exactly (regression oracles in Task 1).
- Test commands: `npm run test -w @fiddle/client` (855 tests currently green), typecheck `npm run typecheck -w @fiddle/client`. Each task must end with both green.
- Commit per task; stage ONLY the named files (never `git add -A`/`-u`; never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`). Every commit message ends with the two trailer lines shown in each commit step.
- Local browser testing (final gates only) uses `npm run dev:obs` — NEVER `npm run dev`.

---

### Task 1: Rows-based draft producers (add-only)

**Files:**
- Modify: `packages/client/src/project/mutations.ts` (append after `moveRangeDraft`, line 85)
- Modify: `packages/client/src/project/index.ts:14` (barrel)
- Test: `packages/client/src/project/mutations.test.ts` (append)

**Interfaces:**
- Consumes: existing `Step` type, `freshStep` from `./factory`.
- Produces (Task 3 relies on these exact signatures):
  - `toggleMuteRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[]`
  - `clearRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[]`
  - `pasteCellsDraft(steps: readonly Step[], start: number, cells: readonly (Step | null)[], patternLength: number): Step[]`
  - `moveRowsDraft(steps: readonly Step[], rows: readonly number[], direction: 'up' | 'down'): Step[]`
- The old producers (`clearRangeDraft`, `pasteStepsDraft`, `toggleMuteRangeDraft`, `moveRangeDraft`) are NOT touched in this task; Task 3 deletes them.

**Spec deviation (intentional):** the spec sketched `pasteCellsDraft(steps, start, cells)` clipping at `steps.length`; the correct clip bound is the pattern window (`patternLength` may be 16 while the steps buffer is 64 — pasting must never write into invisible rows, same rule as the existing `pasteStepsDraft`). The signature therefore takes `patternLength` explicitly.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/project/mutations.test.ts` (imports: extend line 4's import list with `toggleMuteRowsDraft, clearRowsDraft, pasteCellsDraft, moveRowsDraft`):

```ts
describe('toggleMuteRowsDraft', () => {
  it('contiguous rows reproduce toggleMuteRangeDraft exactly (regression oracle vs 610603c)', () => {
    const t = freshTrack();
    t.steps[2].muted = true; t.steps[2].note = 'C';
    t.steps[3].muted = false; t.steps[3].note = 'D';
    const draft = toggleMuteRowsDraft(t.steps, [2, 3, 4]);
    expect(draft.map((s) => s.muted)).toEqual([false, true, true]);
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', null]);
  });

  it('gapped rows: members flip, gap rows are copied through unchanged', () => {
    const t = freshTrack();
    t.steps[3].muted = true; t.steps[3].note = 'G';
    const draft = toggleMuteRowsDraft(t.steps, [2, 5]);
    expect(draft).toHaveLength(4); // span [2..5]
    expect(draft.map((s) => s.muted)).toEqual([true, true, false, true]);
    expect(draft[1].note).toBe('G'); // gap row content intact
  });

  it('returns copies and never mutates the input', () => {
    const t = freshTrack();
    const draft = toggleMuteRowsDraft(t.steps, [0, 2]);
    expect(draft[0]).not.toBe(t.steps[0]);
    expect(draft[1]).not.toBe(t.steps[1]);
    expect(t.steps[0].muted).toBe(false);
    expect(t.steps[1].muted).toBe(false);
  });
});

describe('clearRowsDraft', () => {
  it('members become factory-default steps; gap rows copy through', () => {
    const t = freshTrack();
    t.steps[2].note = 'C'; t.steps[3].note = 'D'; t.steps[4].note = 'E';
    const draft = clearRowsDraft(t.steps, [2, 4]);
    expect(draft).toHaveLength(3);
    expect(draft[0]).toEqual(freshStep());
    expect(draft[1].note).toBe('D'); // gap untouched
    expect(draft[2]).toEqual(freshStep());
  });

  it('contiguous rows produce a fresh step per row (clearRangeDraft oracle)', () => {
    const t = freshTrack();
    const draft = clearRowsDraft(t.steps, [3, 4, 5, 6]);
    expect(draft).toHaveLength(4);
    for (const s of draft) expect(s).toEqual(freshStep());
  });

  it('never mutates the input', () => {
    const t = freshTrack();
    t.steps[2].note = 'C';
    clearRowsDraft(t.steps, [2]);
    expect(t.steps[2].note).toBe('C');
  });
});

describe('pasteCellsDraft', () => {
  function dest(): Step[] {
    const t = freshTrack();
    t.steps[9].note = 'G'; t.steps[10].note = 'A'; t.steps[11].note = 'B';
    return t.steps;
  }
  const cells: (Step | null)[] = [
    { ...freshStep(), note: 'C' },
    null,
    { ...freshStep(), note: 'E' },
  ];

  it('non-null cells overwrite; null holes copy the destination row through', () => {
    const draft = pasteCellsDraft(dest(), 9, cells, 16);
    expect(draft.map((s) => s.note)).toEqual(['C', 'A', 'E']);
  });

  it('clips at the pattern window, not the steps buffer', () => {
    const draft = pasteCellsDraft(dest(), 14, cells, 16);
    expect(draft).toHaveLength(2); // rows 14,15 only — buffer has 64 slots
    expect(pasteCellsDraft(dest(), 16, cells, 16)).toEqual([]);
  });

  it('returns copies, not references (cells and destination alike)', () => {
    const steps = dest();
    const draft = pasteCellsDraft(steps, 9, cells, 16);
    expect(draft[0]).not.toBe(cells[0]);
    expect(draft[1]).not.toBe(steps[10]);
  });
});

describe('moveRowsDraft', () => {
  // Distinct note markers on rows 1..7.
  function marked(): Step[] {
    const t = freshTrack();
    const notes = ['A', 'C', 'D', 'E', 'F', 'G', 'B'];
    notes.forEach((n, i) => { t.steps[i + 1].note = n; });
    return t.steps;
  }

  it('contiguous up reproduces moveRangeDraft exactly (610603c oracle)', () => {
    expect(moveRowsDraft(marked(), [2, 3, 4], 'up').map((s) => s.note))
      .toEqual(['C', 'D', 'E', 'A']); // rows 1..4 = block first, displaced last
  });

  it('contiguous down reproduces moveRangeDraft exactly (610603c oracle)', () => {
    expect(moveRowsDraft(marked(), [2, 3, 4], 'down').map((s) => s.note))
      .toEqual(['F', 'C', 'D', 'E']); // rows 2..5 = displaced first, block after
  });

  it('gapped down: constellation shifts rigidly, unselected fill vacated slots in order', () => {
    // rows 2,5,6 of [1:A 2:C 3:D 4:E 5:F 6:G 7:B]; window [2..7].
    // Selected land on 3,6,7; unselected old 3,4,7 fill slots 2,4,5 in order.
    expect(moveRowsDraft(marked(), [2, 5, 6], 'down').map((s) => s.note))
      .toEqual(['D', 'C', 'E', 'B', 'F', 'G']); // rows 2..7
  });

  it('gapped up: mirror of the worked example', () => {
    // rows 2,5,6 up; window [1..6]. Selected land on 1,4,5;
    // unselected old 1,3,4 fill slots 2,3,6 in order.
    expect(moveRowsDraft(marked(), [2, 5, 6], 'up').map((s) => s.note))
      .toEqual(['C', 'A', 'D', 'F', 'G', 'E']); // rows 1..6
  });

  it('single gapped pair moves both directions', () => {
    // rows 2,4 down: window [2..5], selected land 3,5; unselected old 3,5 → slots 2,4.
    expect(moveRowsDraft(marked(), [2, 4], 'down').map((s) => s.note))
      .toEqual(['D', 'C', 'F', 'E']);
    // rows 2,4 up: window [1..4], selected land 1,3; unselected old 1,3 → slots 2,4.
    expect(moveRowsDraft(marked(), [2, 4], 'up').map((s) => s.note))
      .toEqual(['C', 'A', 'E', 'D']);
  });

  it('returns copies, never references into the input array', () => {
    const steps = marked();
    for (const row of moveRowsDraft(steps, [2, 5], 'down')) {
      expect(steps.includes(row as Step)).toBe(false);
    }
  });

  it('defensive: missing neighbor returns [] (up at row 0, down at the buffer end)', () => {
    const steps = marked();
    expect(moveRowsDraft(steps, [0, 2], 'up')).toEqual([]);
    expect(moveRowsDraft(steps, [60, 63], 'down')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm run test -w @fiddle/client -- src/project/mutations.test.ts`
Expected: FAIL — `toggleMuteRowsDraft is not a function` (module has no such export).

- [ ] **Step 3: Implement the four producers**

Append to `packages/client/src/project/mutations.ts` (after `moveRangeDraft`):

```ts
// ---- rows-based producers (gapped selections; cmd+click multi-select) ----
// `rows` is sorted ascending, deduped, non-empty (validSelection guarantees
// it). Each producer returns a span draft with gap rows copied through
// unchanged — the caller's diff (dispatchStepsRange) drops them, so only
// member rows dispatch.

/** Span draft [rows[0]..last]: member rows get `muted` inverted (rests
 *  included), gap rows copy through. Contiguous rows == old toggleMuteRangeDraft. */
export function toggleMuteRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[] {
  const first = rows[0];
  const members = new Set(rows);
  return steps.slice(first, rows[rows.length - 1] + 1).map((s, i) =>
    members.has(first + i) ? { ...s, muted: !s.muted } : { ...s },
  );
}

/** Span draft: member rows become factory-default steps, gap rows copy through. */
export function clearRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[] {
  const first = rows[0];
  const members = new Set(rows);
  return steps.slice(first, rows[rows.length - 1] + 1).map((s, i) =>
    members.has(first + i) ? freshStep() : { ...s },
  );
}

/** Transparent paste: draft over [start..], clipped at the pattern window
 *  (never the 64-slot buffer). Non-null cells overwrite; null holes copy the
 *  existing destination row through, so content under a hole survives. */
export function pasteCellsDraft(
  steps: readonly Step[],
  start: number,
  cells: readonly (Step | null)[],
  patternLength: number,
): Step[] {
  return cells.slice(0, Math.max(0, patternLength - start)).map((c, i) =>
    c ? { ...c } : { ...steps[start + i] },
  );
}

/** Rigid constellation move (USER DECIDED): selected rows shift one row toward
 *  `direction` preserving their gaps; unselected rows inside the affected
 *  window fill the vacated slots preserving their relative order. Window:
 *  up -> [first-1..last], down -> [first..last+1]. Contiguous rows reproduce
 *  the old moveRangeDraft exactly (block + displaced neighbor).
 *  Precondition (caller-enforced clamp): the neighbor row exists in the
 *  buffer; a violated precondition returns [] so nothing dispatches. */
export function moveRowsDraft(
  steps: readonly Step[],
  rows: readonly number[],
  direction: 'up' | 'down',
): Step[] {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (direction === 'up' ? first <= 0 : last >= steps.length - 1) return [];
  const delta = direction === 'up' ? -1 : 1;
  const windowStart = direction === 'up' ? first - 1 : first;
  const size = last - first + 2; // span + the displaced neighbor
  const members = new Set(rows);
  const draft: (Step | undefined)[] = new Array(size);
  for (const r of rows) draft[r + delta - windowStart] = { ...steps[r] };
  const fillers: Step[] = [];
  for (let r = windowStart; r < windowStart + size; r++) {
    if (!members.has(r)) fillers.push({ ...steps[r] });
  }
  let f = 0;
  for (let i = 0; i < size; i++) {
    if (draft[i] === undefined) draft[i] = fillers[f++];
  }
  return draft as Step[];
}
```

Update the barrel `packages/client/src/project/index.ts` line 14 to:

```ts
export { clearTrackDraft, shiftTrackDraft, fillTrackDraft, clearRangeDraft, pasteStepsDraft, toggleMuteRangeDraft, moveRangeDraft, toggleMuteRowsDraft, clearRowsDraft, pasteCellsDraft, moveRowsDraft } from './mutations';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @fiddle/client -- src/project/mutations.test.ts`
Expected: PASS (all suites in the file, old and new).

- [ ] **Step 5: Full client suite + typecheck**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client`
Expected: 855 + 15 new = 870 tests pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/project/mutations.ts packages/client/src/project/mutations.test.ts packages/client/src/project/index.ts
git commit -m "feat(client): rows-based draft producers for gapped step selections

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 2: Selection store — frozen set + generalized ValidSelection

**Files:**
- Modify: `packages/client/src/stores/selection.ts` (full rewrite, shown below)
- Test: `packages/client/src/stores/selection.test.ts` (full rewrite, shown below)
- Modify: `packages/client/src/components/Tracker.test.ts` (assertion migration, exact rule below)
- Modify: `packages/client/src/keyboard/trackerCommands.test.ts` (assertion migration, same rule)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 3–4 rely on these):
  - `ValidSelection` = `{ trackId, rows: readonly number[], ranges: readonly {start,end}[], first, last, head, start, end }` — `start`/`end` are TRANSITIONAL duplicates of `first`/`last` so `trackerCommands.ts` keeps compiling/behaving until Task 3 removes them.
  - Actions: `toggleRow(tid, row)`, `shiftAll(delta)`, `selectRows(tid, rows)`; `place`/`moveCursor`/`clear` now reset `frozen`; `extendTo`/`extendCursor` preserve it.
  - `isSelected(tid, row)` is Set-backed (O(1)).
- The raw `frozen` ref is NOT exported — consumers read `validSelection` only, same discipline as today.

- [ ] **Step 1: Rewrite the store test file (failing tests)**

Replace the whole of `packages/client/src/stores/selection.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useProjectStore } from './project';
import { useSelectionStore } from './selection';

describe('selection store', () => {
  let project: ReturnType<typeof useProjectStore>;
  let sel: ReturnType<typeof useSelectionStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    project = useProjectStore();
    sel = useSelectionStore();
    project.project.tracks[0].patternLength = 16;
  });

  it('starts empty: validSelection is null', () => {
    expect(sel.validSelection).toBeNull();
  });

  it('place sets a collapsed selection (anchor = head = row)', () => {
    sel.place(0, 5);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 5, last: 5, head: 5, rows: [5] });
    expect(sel.size).toBe(1);
  });

  it('extendTo grows the range from the anchor; upward extension normalizes first/last', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 5, last: 8, head: 8 });
    sel.extendTo(0, 2);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 2, last: 5, head: 2 });
    expect(sel.size).toBe(4);
  });

  it('extendTo on a different track behaves as place', () => {
    project.project.tracks[1].patternLength = 16;
    sel.place(0, 5);
    sel.extendTo(1, 8);
    expect(sel.validSelection).toMatchObject({ trackId: 1, first: 8, last: 8, head: 8 });
  });

  it('moveCursor collapses and moves, clamped to the pattern window', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    sel.moveCursor(1);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 9, last: 9, head: 9 });
    sel.moveCursor(-100);
    expect(sel.validSelection!.head).toBe(0);
    sel.moveCursor(100);
    expect(sel.validSelection!.head).toBe(15);
  });

  it('extendCursor moves only the head, clamped', () => {
    sel.place(0, 5);
    sel.extendCursor(2);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 5, last: 7, head: 7 });
    sel.extendCursor(-100);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 0, last: 5, head: 0 });
  });

  it('moveCursor/extendCursor are no-ops without a valid selection', () => {
    sel.moveCursor(1);
    sel.extendCursor(1);
    expect(sel.validSelection).toBeNull();
  });

  it('isSelected answers per-track per-row', () => {
    sel.place(0, 3);
    sel.extendTo(0, 5);
    expect(sel.isSelected(0, 4)).toBe(true);
    expect(sel.isSelected(0, 6)).toBe(false);
    expect(sel.isSelected(1, 4)).toBe(false);
  });

  it('validSelection clamps a range that pattern-shrink left partially outside', () => {
    sel.place(0, 10);
    sel.extendTo(0, 14);
    project.project.tracks[0].patternLength = 12;
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 10, last: 11, head: 11 });
  });

  it('validSelection is null when the range is fully outside the window', () => {
    sel.place(0, 10);
    project.project.tracks[0].patternLength = 8;
    expect(sel.validSelection).toBeNull();
  });

  it('validSelection is null for a disabled track and clear() empties', () => {
    sel.place(0, 3);
    project.project.tracks[0].enabled = false;
    expect(sel.validSelection).toBeNull();
    project.project.tracks[0].enabled = true;
    sel.clear();
    expect(sel.trackId).toBeNull();
    expect(sel.validSelection).toBeNull();
  });

  // ---- multi-select (cmd+click) ----

  it('toggleRow with no selection (or another track) behaves as place', () => {
    sel.toggleRow(0, 4);
    expect(sel.validSelection).toMatchObject({ trackId: 0, rows: [4], head: 4 });
    project.project.tracks[1].patternLength = 16;
    sel.toggleRow(1, 7); // different track → fresh selection there
    expect(sel.validSelection).toMatchObject({ trackId: 1, rows: [7], head: 7 });
  });

  it('toggleRow on an unselected row freezes the active segment and collapses there', () => {
    sel.place(0, 2);
    sel.extendTo(0, 4); // active 2..4
    sel.toggleRow(0, 8);
    expect(sel.validSelection).toMatchObject({ trackId: 0, rows: [2, 3, 4, 8], first: 2, last: 8, head: 8 });
    expect(sel.validSelection!.ranges).toEqual([{ start: 2, end: 4 }, { start: 8, end: 8 }]);
  });

  it('shift-extend after toggleRow reshapes only the active segment; frozen rows persist', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 8);
    sel.extendTo(0, 11); // active 8..11
    expect(sel.validSelection!.rows).toEqual([2, 8, 9, 10, 11]);
    sel.extendTo(0, 9); // shrink active to 8..9 — 10,11 drop, 2 survives
    expect(sel.validSelection!.rows).toEqual([2, 8, 9]);
    sel.extendCursor(1); // keyboard shift+down: active 8..10
    expect(sel.validSelection!.rows).toEqual([2, 8, 9, 10]);
  });

  it('toggleRow off keeps the cursor at the old head when the head survives', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 5);
    sel.toggleRow(0, 8); // rows 2,5,8; head 8
    sel.toggleRow(0, 5); // remove a non-head row
    expect(sel.validSelection).toMatchObject({ rows: [2, 8], head: 8 });
  });

  it('toggleRow off the head moves the cursor to the nearest remaining row (tie → lower)', () => {
    sel.place(0, 4);
    sel.toggleRow(0, 6); // rows 4,6; head 6
    sel.toggleRow(0, 6); // remove the head; nearest remaining is 4
    expect(sel.validSelection).toMatchObject({ rows: [4], head: 4 });
    sel.toggleRow(0, 2); // rows 2,4
    sel.toggleRow(0, 8); // rows 2,4,8; head 8
    sel.toggleRow(0, 8); // equidistant would need a mid row — nearest to 8 is 4
    expect(sel.validSelection).toMatchObject({ rows: [2, 4], head: 4 });
    sel.toggleRow(0, 3); // rows 2,3,4; head 3
    sel.toggleRow(0, 3); // 2 and 4 equidistant from 3 → tie goes to the lower (2)
    expect(sel.validSelection).toMatchObject({ rows: [2, 4], head: 2 });
  });

  it('toggling off the only selected row clears the selection', () => {
    sel.toggleRow(0, 4);
    sel.toggleRow(0, 4);
    expect(sel.validSelection).toBeNull();
    expect(sel.trackId).toBeNull();
  });

  it('rows and ranges are sorted/deduped when frozen overlaps the active segment', () => {
    sel.place(0, 5);
    sel.toggleRow(0, 3); // frozen {5}, active 3
    sel.extendTo(0, 6);  // active 3..6 overlaps frozen 5
    expect(sel.validSelection!.rows).toEqual([3, 4, 5, 6]);
    expect(sel.validSelection!.ranges).toEqual([{ start: 3, end: 6 }]);
  });

  it('place and moveCursor reset frozen rows; a plain gesture collapses the multi-selection', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 8);
    sel.place(0, 5);
    expect(sel.validSelection!.rows).toEqual([5]);
    sel.toggleRow(0, 9);
    sel.moveCursor(1);
    expect(sel.validSelection!.rows).toEqual([10]);
  });

  it('pattern shrink filters frozen rows from the read without mutating state', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 14); // frozen {2}, active 14
    project.project.tracks[0].patternLength = 12;
    expect(sel.validSelection).toMatchObject({ rows: [2], head: 11 });
    project.project.tracks[0].patternLength = 16;
    expect(sel.validSelection!.rows).toEqual([2, 14]); // 14 was never deleted
  });

  it('shiftAll shifts frozen rows, anchor, and head together', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 5);
    sel.extendTo(0, 6); // rows 2,5,6; head 6
    sel.shiftAll(1);
    expect(sel.validSelection).toMatchObject({ rows: [3, 6, 7], head: 7 });
    sel.shiftAll(-1);
    expect(sel.validSelection).toMatchObject({ rows: [2, 5, 6], head: 6 });
  });

  it('selectRows selects exactly the given rows with the head on the last', () => {
    sel.selectRows(0, [3, 7, 9]);
    expect(sel.validSelection).toMatchObject({ trackId: 0, rows: [3, 7, 9], head: 9 });
    expect(sel.validSelection!.ranges).toEqual([{ start: 3, end: 3 }, { start: 7, end: 7 }, { start: 9, end: 9 }]);
    sel.selectRows(0, []); // no-op
    expect(sel.validSelection!.rows).toEqual([3, 7, 9]);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm run test -w @fiddle/client -- src/stores/selection.test.ts`
Expected: FAIL — `sel.toggleRow is not a function` (plus toMatchObject misses `first`/`rows`).

- [ ] **Step 3: Rewrite the store**

Replace the whole of `packages/client/src/stores/selection.ts` with:

```ts
//
// Tracker row selection — STRICTLY LOCAL UI state. Never dispatched, never
// enqueued, never persisted; each peer has their own selection.
//
// Model (cmd+click multi-select spec): the selection is `frozen` rows —
// committed by earlier cmd+clicks — plus ONE active segment (anchor..head).
// Shift/drag gestures reshape only the active segment; cmd+click freezes it
// and starts a new one. A selection with no frozen rows is exactly the old
// single-range model.
//
// Consumers must read `validSelection`, never the raw refs: it revalidates
// against live project state on every read, so pattern shrink, track disable,
// or a project load can never leave a phantom selection targeting rows that
// don't exist.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useProjectStore } from './project';

export interface ValidSelection {
  trackId: number;
  rows: readonly number[]; // sorted, deduped, clamped to the pattern window
  ranges: readonly { start: number; end: number }[]; // contiguous runs of rows
  first: number; // rows[0]
  last: number;  // rows[rows.length - 1]
  head: number;  // the cursor (the moving end of the active segment)
  /** TRANSITIONAL (Task 3 removes them): span bounds, = first/last. */
  start: number;
  end: number;
}

export const useSelectionStore = defineStore('selection', () => {
  const projectStore = useProjectStore();

  const trackId = ref<number | null>(null);
  const anchor = ref(0);
  const head = ref(0);
  const frozen = ref<Set<number>>(new Set());

  const validSelection = computed<ValidSelection | null>(() => {
    const tid = trackId.value;
    if (tid === null) return null;
    const track = projectStore.project.tracks[tid];
    if (!track || !track.enabled) return null;
    const max = track.patternLength - 1;
    const activeStart = Math.max(0, Math.min(anchor.value, head.value));
    const activeEnd = Math.min(Math.max(anchor.value, head.value), max);
    const rowSet = new Set<number>();
    for (let r = activeStart; r <= activeEnd; r++) rowSet.add(r);
    for (const r of frozen.value) if (r >= 0 && r <= max) rowSet.add(r);
    if (rowSet.size === 0) return null;
    const rows = [...rowSet].sort((a, b) => a - b);
    const ranges: { start: number; end: number }[] = [];
    for (const r of rows) {
      const run = ranges[ranges.length - 1];
      if (run && r === run.end + 1) run.end = r;
      else ranges.push({ start: r, end: r });
    }
    return {
      trackId: tid,
      rows,
      ranges,
      first: rows[0],
      last: rows[rows.length - 1],
      head: Math.min(Math.max(head.value, 0), max),
      start: rows[0],
      end: rows[rows.length - 1],
    };
  });

  const size = computed(() => validSelection.value?.rows.length ?? 0);

  const selectedRowSet = computed<Set<number>>(() => new Set(validSelection.value?.rows ?? []));

  function isSelected(tid: number, row: number): boolean {
    const s = validSelection.value;
    return s !== null && s.trackId === tid && selectedRowSet.value.has(row);
  }

  function place(tid: number, row: number): void {
    trackId.value = tid;
    anchor.value = row;
    head.value = row;
    frozen.value = new Set();
  }

  function extendTo(tid: number, row: number): void {
    if (trackId.value !== tid) { place(tid, row); return; }
    head.value = row;
  }

  function clampToWindow(row: number): number {
    const s = validSelection.value;
    if (!s) return row;
    const max = projectStore.project.tracks[s.trackId].patternLength - 1;
    return Math.min(Math.max(row, 0), max);
  }

  /** Collapse & move: the whole selection (frozen included) collapses to
   *  clamped(head + delta). No-op without a valid selection. */
  function moveCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    const next = clampToWindow(s.head + delta);
    anchor.value = next;
    head.value = next;
    frozen.value = new Set();
  }

  /** Move only the head (Shift+arrow) — reshapes the active segment, frozen
   *  rows persist. No-op without a valid selection. */
  function extendCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    head.value = clampToWindow(s.head + delta);
  }

  /** Cmd/Ctrl+click: toggle `row` in/out of the selection.
   *  Not selected → freeze the current rows and start a new collapsed active
   *  segment at `row`. Selected → remove it; the cursor stays at the old head
   *  when the head survives, else jumps to the nearest remaining row (tie →
   *  lower); removing the only row clears. */
  function toggleRow(tid: number, row: number): void {
    const s = validSelection.value;
    if (!s || s.trackId !== tid) { place(tid, row); return; }
    if (!selectedRowSet.value.has(row)) {
      frozen.value = new Set(s.rows); // validated rows — stale entries drop here
      anchor.value = row;
      head.value = row;
      return;
    }
    const remaining = s.rows.filter((r) => r !== row);
    if (remaining.length === 0) { clear(); return; }
    const cursor = remaining.includes(s.head)
      ? s.head
      : remaining.reduce((best, r) => {
          const dr = Math.abs(r - row);
          const db = Math.abs(best - row);
          return dr < db || (dr === db && r < best) ? r : best;
        });
    frozen.value = new Set(remaining.filter((r) => r !== cursor));
    anchor.value = cursor;
    head.value = cursor;
  }

  /** Shift the whole selection by `delta` (selection-follow after a
   *  constellation move). The caller guarantees the result stays inside the
   *  pattern window; validSelection self-heals stray rows on read anyway. */
  function shiftAll(delta: number): void {
    frozen.value = new Set([...frozen.value].map((r) => r + delta));
    anchor.value += delta;
    head.value += delta;
  }

  /** Select exactly `rows` (sorted ascending, non-empty; no-op on empty):
   *  frozen = all but the last, active segment collapsed on the last. Used to
   *  mirror a pasted constellation. */
  function selectRows(tid: number, rows: readonly number[]): void {
    if (rows.length === 0) return;
    trackId.value = tid;
    frozen.value = new Set(rows.slice(0, -1));
    const last = rows[rows.length - 1];
    anchor.value = last;
    head.value = last;
  }

  function clear(): void {
    trackId.value = null;
    frozen.value = new Set();
  }

  return { trackId, anchor, head, validSelection, size, isSelected, place, extendTo, moveCursor, extendCursor, toggleRow, shiftAll, selectRows, clear };
});
```

- [ ] **Step 4: Run the store tests**

Run: `npm run test -w @fiddle/client -- src/stores/selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Migrate assertions in the two dependent test files**

The shape change breaks every `toEqual({ trackId, start, end, head })` assertion (extra fields make exact equality fail). Apply this mechanical rule in BOTH files — change ONLY the matcher and key names, never the values:

`expect(X).toEqual({ trackId: T, start: A, end: B, head: H })` → `expect(X).toMatchObject({ trackId: T, first: A, last: B, head: H })`

In `packages/client/src/components/Tracker.test.ts` the occurrences are at lines 250, 253, 269, 283, 292, 295, 318, 326, 335, 345 (all inside `describe('step selection UI')`). Example — line 250:

```ts
expect(selection.validSelection).toMatchObject({ trackId: 2, first: 3, last: 3, head: 3 });
```

In `packages/client/src/keyboard/trackerCommands.test.ts` the occurrences are at lines 75, 91, 99, 106, 119, 121, 147, 156, 161, 169, 177. Example — line 169:

```ts
expect(selection.validSelection).toMatchObject({ trackId: 0, first: 3, last: 5, head: 5 });
```

(`trackerCommands.ts` itself is untouched — it still reads `s.start`/`s.end`, which the transitional fields keep populated with identical values for every contiguous selection, and gapped selections cannot be created through any wired gesture yet.)

- [ ] **Step 6: Full client suite + typecheck**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client`
Expected: all tests pass; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/stores/selection.ts packages/client/src/stores/selection.test.ts packages/client/src/components/Tracker.test.ts packages/client/src/keyboard/trackerCommands.test.ts
git commit -m "feat(client): selection store learns frozen rows + active segment (multi-select model)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 3: Contract flip — rows-based ops, gapped clipboard, commands

**Files:**
- Modify: `packages/client/src/stores/stepClipboard.ts` (cells with holes)
- Modify: `packages/client/src/stores/stepClipboard.test.ts` (append one test)
- Modify: `packages/client/src/app/projectOps.ts:18-19` (imports) and `:235-255` (ops)
- Modify: `packages/client/src/app/projectOps.test.ts:160-200` (`step range ops` describe)
- Modify: `packages/client/src/keyboard/trackerCommands.ts` (ops interface + rows reads)
- Modify: `packages/client/src/keyboard/trackerCommands.test.ts` (ops mocks + gapped cases)
- Modify: `packages/client/src/project/mutations.ts` (DELETE `clearRangeDraft`, `pasteStepsDraft`, `toggleMuteRangeDraft`, `moveRangeDraft`)
- Modify: `packages/client/src/project/mutations.test.ts` (DELETE those four describes)
- Modify: `packages/client/src/project/index.ts:14` (barrel: drop the four old names)
- Modify: `packages/client/src/stores/selection.ts` (DELETE transitional `start`/`end`)

**Interfaces:**
- Consumes: Task 1 producers (exact signatures listed there); Task 2 store (`s.rows`/`s.first`/`s.last`, `selectRows`, `shiftAll`).
- Produces: the final ops contract consumed by StudioView's existing wiring (`ops: projectOps` — structural typing, StudioView.vue is untouched):

```ts
clearStepRows(trackId: number, rows: readonly number[]): void
pasteSteps(trackId: number, cursor: number, cells: readonly (Step | null)[]): number[]
toggleMuteRows(trackId: number, rows: readonly number[]): void
moveStepRows(trackId: number, rows: readonly number[], direction: 'up' | 'down'): void
```

- [ ] **Step 1: Widen the clipboard**

Replace the body of `packages/client/src/stores/stepClipboard.ts` with:

```ts
//
// In-memory step clipboard — LOCAL ONLY (never synced, never persisted; gone
// on reload). Cells are a span with holes: null marks an unselected row inside
// the copied span (transparent on paste — the destination row survives).
// First/last cells are non-null by construction (copy trims to the selection
// bounds). Non-null cells are plain deep copies: every Step field is a
// primitive, so a spread per row fully detaches from the reactive source.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Step } from '@fiddle/shared';

export const useStepClipboardStore = defineStore('stepClipboard', () => {
  const rows = ref<(Step | null)[] | null>(null);

  function set(cells: readonly (Step | null)[]): void {
    rows.value = cells.map((c) => (c ? { ...c } : null));
  }

  return { rows, set };
});
```

Append to `packages/client/src/stores/stepClipboard.test.ts` (existing tests keep passing — `Step[]` is assignable to `(Step | null)[]`):

```ts
  it('preserves null holes and deep-copies the non-null cells around them', () => {
    const clip = useStepClipboardStore();
    const source: (Step | null)[] = [{ ...freshStep(), note: 'C' }, null, { ...freshStep(), note: 'E' }];
    clip.set(source);
    expect(clip.rows![1]).toBeNull();
    (source[2] as Step).note = 'G';
    expect(clip.rows![2]!.note).toBe('E');
  });
```

- [ ] **Step 2: Flip the ops in projectOps.ts**

Update the import at lines 18–19 to:

```ts
  clearTrackDraft, shiftTrackDraft, fillTrackDraft,
  toggleMuteRowsDraft, clearRowsDraft, pasteCellsDraft, moveRowsDraft,
```

Replace the four selection ops (current lines 232–255, from the `// Selection ops` comment through `moveStepRange`) with:

```ts
    // Selection ops (keyboard copy/cut/clear/paste + M/alt+arrows). Rows-based:
    // a selection may be gapped (cmd+click multi-select). Producers build a
    // span draft with gap rows copied through unchanged, so the diff dispatches
    // only member changes — same draft-diff-dispatch discipline as clearTrack/
    // fillTrack; every leaf carries its prior for sync rollback / future undo.
    clearStepRows(trackId: number, rows: readonly number[]): void {
      const t = project.tracks[trackId];
      dispatchStepsRange(trackId, rows[0], clearRowsDraft(t.steps, rows) as unknown as Record<string, unknown>[]);
    },
    /** Transparent paste at `cursor`, clipped at the pattern window; null cells
     *  leave destination rows untouched. Returns the ABSOLUTE rows written
     *  (the caller re-selects exactly these). */
    pasteSteps(trackId: number, cursor: number, cells: readonly (Step | null)[]): number[] {
      const t = project.tracks[trackId];
      const draft = pasteCellsDraft(t.steps, cursor, cells, t.patternLength);
      dispatchStepsRange(trackId, cursor, draft as unknown as Record<string, unknown>[]);
      return cells.slice(0, draft.length).flatMap((c, i) => (c ? [cursor + i] : []));
    },
    /** Per-step mute flip over the selected rows; gap rows untouched. */
    toggleMuteRows(trackId: number, rows: readonly number[]): void {
      const t = project.tracks[trackId];
      dispatchStepsRange(trackId, rows[0], toggleMuteRowsDraft(t.steps, rows) as unknown as Record<string, unknown>[]);
    },
    /** Rigid constellation move: selected rows shift ±1 preserving gaps;
     *  displaced unselected rows fill the vacated slots in order. Caller
     *  clamps at the pattern-window edges. */
    moveStepRows(trackId: number, rows: readonly number[], direction: 'up' | 'down'): void {
      const t = project.tracks[trackId];
      const windowStart = direction === 'up' ? rows[0] - 1 : rows[0];
      dispatchStepsRange(trackId, windowStart, moveRowsDraft(t.steps, rows, direction) as unknown as Record<string, unknown>[]);
    },
```

- [ ] **Step 3: Update the `step range ops` describe in projectOps.test.ts**

Replace the whole `describe('step range ops', …)` block (lines 160–200) with:

```ts
describe('step rows ops', () => {
  it('clearStepRows dispatches only the leaves that differ from an empty step, with priors', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].steps[2].note = 'C';
    project.tracks[0].steps[2].velocity = 0.5;
    project.tracks[0].steps[3].note = 'D';
    ops.clearStepRows(0, [2, 3]);
    const paths = dispatched.map((d) => d.path.join('.'));
    expect(paths).toContain('tracks.0.steps.2.note');
    expect(paths).toContain('tracks.0.steps.2.velocity');
    expect(paths).toContain('tracks.0.steps.3.note');
    expect(paths.every((p) => p.startsWith('tracks.0.steps.2') || p.startsWith('tracks.0.steps.3'))).toBe(true);
    const note2 = dispatched.find((d) => d.path.join('.') === 'tracks.0.steps.2.note')!;
    expect(note2.value).toBeNull();
    expect(note2.priorValue).toBe('C');
  });

  it('clearStepRows on gapped rows leaves the gap row completely untouched', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].steps[2].note = 'C';
    project.tracks[0].steps[3].note = 'D';
    project.tracks[0].steps[4].note = 'E';
    ops.clearStepRows(0, [2, 4]);
    const paths = dispatched.map((d) => d.path.join('.'));
    expect(paths.some((p) => p.startsWith('tracks.0.steps.3'))).toBe(false);
    expect(paths).toContain('tracks.0.steps.2.note');
    expect(paths).toContain('tracks.0.steps.4.note');
  });

  it('pasteSteps writes cells at the cursor, clips at patternLength, and returns the absolute rows written', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[1].patternLength = 16;
    const cells = [
      { ...freshStep(), note: 'C' },
      { ...freshStep(), note: 'D' },
      { ...freshStep(), note: 'E' },
    ];
    const written = ops.pasteSteps(1, 14, cells);
    expect(written).toEqual([14, 15]);
    const notePaths = dispatched.filter((d) => String(d.path[d.path.length - 1]) === 'note');
    expect(notePaths.map((d) => d.path.join('.'))).toEqual(['tracks.1.steps.14.note', 'tracks.1.steps.15.note']);
    expect(notePaths.map((d) => d.value)).toEqual(['C', 'D']);
  });

  it('pasteSteps null holes are transparent: destination row untouched, hole row not in the result', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].steps[6].note = 'B'; // sits under the hole
    const written = ops.pasteSteps(0, 5, [{ ...freshStep(), note: 'C' }, null, { ...freshStep(), note: 'E' }]);
    expect(written).toEqual([5, 7]);
    expect(project.tracks[0].steps[6].note).toBe('B');
    expect(dispatched.some((d) => d.path.join('.').startsWith('tracks.0.steps.6'))).toBe(false);
  });

  it('pasteSteps of identical content dispatches nothing (diff-based)', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].steps[0].note = 'C';
    const written = ops.pasteSteps(0, 0, [{ ...freshStep(), note: 'C' }]);
    expect(written).toEqual([0]); // row was in range and processed…
    expect(dispatched).toHaveLength(0); // …but no leaf differed
  });
});
```

- [ ] **Step 4: Flip trackerCommands.ts to the rows contract**

In `packages/client/src/keyboard/trackerCommands.ts`:

Replace the `ops` block of `TrackerCommandDeps` (lines 13–18) with:

```ts
  ops: {
    clearStepRows(trackId: number, rows: readonly number[]): void;
    pasteSteps(trackId: number, cursor: number, cells: readonly (Step | null)[]): number[];
    toggleMuteRows(trackId: number, rows: readonly number[]): void;
    moveStepRows(trackId: number, rows: readonly number[], direction: 'up' | 'down'): void;
  };
```

Replace `copySelection` (lines 29–33) with:

```ts
  function copySelection(): void {
    const s = sel();
    if (!s) return;
    // Span with holes: null marks an unselected row — transparent on paste.
    const members = new Set(s.rows);
    clipboard.set(
      project.tracks[s.trackId].steps
        .slice(s.first, s.last + 1)
        .map((step, i) => (members.has(s.first + i) ? step : null)),
    );
  }
```

Replace `moveSelection` (lines 44–56) with:

```ts
  // Alt+arrow move: clamp at the pattern-window edge (spec: complete no-op,
  // nothing dispatched), then move the constellation and carry the whole
  // selection with it — anchor and head shift together, so the cursor stays
  // on the same end.
  function moveSelection(direction: 'up' | 'down'): void {
    const s = sel();
    if (!s) return;
    const max = project.tracks[s.trackId].patternLength - 1;
    if (direction === 'up' ? s.first === 0 : s.last === max) return;
    ops.moveStepRows(s.trackId, s.rows, direction);
    selection.shiftAll(direction === 'up' ? -1 : 1);
  }
```

In `tracker.cut`, replace `ops.clearStepRange(s.trackId, s.start, s.end);` with `ops.clearStepRows(s.trackId, s.rows);`.
In `tracker.clear`, replace `ops.clearStepRange(s.trackId, s.start, s.end);` with `ops.clearStepRows(s.trackId, s.rows);`.
In `tracker.toggleMute`, replace `ops.toggleMuteRange(s.trackId, s.start, s.end);` with `ops.toggleMuteRows(s.trackId, s.rows);`.

Replace `tracker.paste`'s `run` with:

```ts
      run: () => {
        const s = sel();
        const cells = clipboard.rows;
        if (!s || !cells || cells.length === 0) return;
        // Paste target = top of the selection. The op clips at the pattern
        // window and returns the absolute rows written; the selection then
        // mirrors the pasted constellation (M-after-paste hits exactly it).
        const written = ops.pasteSteps(s.trackId, s.first, cells);
        if (written.length > 0) selection.selectRows(s.trackId, written);
      },
```

- [ ] **Step 5: Update trackerCommands.test.ts**

Update the `ops` fixture type + init (lines 23–28 and 37):

```ts
  let ops: {
    clearStepRows: Mock<(trackId: number, rows: readonly number[]) => void>;
    pasteSteps: Mock<(trackId: number, cursor: number, cells: readonly (Step | null)[]) => number[]>;
    toggleMuteRows: Mock<(trackId: number, rows: readonly number[]) => void>;
    moveStepRows: Mock<(trackId: number, rows: readonly number[], direction: 'up' | 'down') => void>;
  };
```

```ts
    ops = { clearStepRows: vi.fn(), pasteSteps: vi.fn(() => [] as number[]), toggleMuteRows: vi.fn(), moveStepRows: vi.fn() };
```

Update the two inline ops literals (in `bindings hygiene` line 189 and the end-to-end describe line 214) to:

```ts
      ops: { clearStepRows: () => {}, pasteSteps: () => [], toggleMuteRows: () => {}, moveStepRows: () => {} },
```

Then update these tests (matcher lines already migrated to `first`/`last` in Task 2 — only op expectations and clipboard shapes change):

- `'copy snapshots the selected rows into the clipboard'`: `clipboard.rows!.map((s) => s!.note)`.
- `'cut = copy + clearStepRange; selection stays'` → rename to `'cut = copy + clearStepRows; selection stays'`; `expect(ops.clearStepRange)…` becomes `expect(ops.clearStepRows).toHaveBeenCalledWith(0, [2, 3]);`; `clipboard.rows!.map((s) => s!.note)`.
- `'clear clears without touching the clipboard'`: `expect(ops.clearStepRows).toHaveBeenCalledWith(0, [2]);`.
- `'paste pastes at the selection start and re-selects the written range'`: `ops.pasteSteps.mockReturnValue([8, 9]);` and the final assertion `expect(selection.validSelection).toMatchObject({ trackId: 0, first: 8, last: 9, head: 9 });` (unchanged from Task 2); the called-with line becomes `expect(ops.pasteSteps).toHaveBeenCalledWith(0, 8, clipboard.rows);`.
- `'paste that writes 0 rows leaves the selection alone'`: `ops.pasteSteps.mockReturnValue([]);`.
- `'toggleMute…'`: `expect(ops.toggleMuteRows).toHaveBeenCalledWith(0, [2, 3, 4]);`.
- `'moveUp at row 0 and moveDown at the pattern end are complete no-ops'`: both `expect(ops.moveStepRange)` lines become `expect(ops.moveStepRows).not.toHaveBeenCalled();`.
- `'moveDown mid-track…'`: `expect(ops.moveStepRows).toHaveBeenCalledWith(0, [2, 3, 4], 'down');`.
- `'moveUp with the head at the TOP…'`: `expect(ops.moveStepRows).toHaveBeenCalledWith(0, [2, 3, 4], 'up');`.
- The end-to-end describe: `clipboard.rows!.map((s) => s!.note)`.

Append these new tests inside `describe('trackerCommands')`:

```ts
  it('gapped copy produces a span with null holes; cut clears only the members', () => {
    projectStore.project.tracks[0].steps[4].note = 'E';
    selection.place(0, 2);
    selection.toggleRow(0, 4); // rows 2,4
    run(byId(cmds, 'tracker.copy'));
    expect(clipboard.rows!.map((s) => s?.note ?? null)).toEqual(['C', null, 'E']);
    run(byId(cmds, 'tracker.cut'));
    expect(ops.clearStepRows).toHaveBeenCalledWith(0, [2, 4]);
  });

  it('paste re-selects exactly the written constellation', () => {
    clipboard.set([projectStore.project.tracks[0].steps[2], null, projectStore.project.tracks[0].steps[3]]);
    ops.pasteSteps.mockReturnValue([8, 10]);
    selection.place(0, 8);
    run(byId(cmds, 'tracker.paste'));
    expect(ops.pasteSteps).toHaveBeenCalledWith(0, 8, clipboard.rows);
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 8, last: 10, head: 10 });
    expect(selection.validSelection!.rows).toEqual([8, 10]);
  });

  it('gapped move: clamps on first/last, dispatches rows, and the whole selection follows', () => {
    selection.place(0, 0);
    selection.toggleRow(0, 3); // rows 0,3 — first === 0
    run(byId(cmds, 'tracker.moveUp'));
    expect(ops.moveStepRows).not.toHaveBeenCalled();
    run(byId(cmds, 'tracker.moveDown'));
    expect(ops.moveStepRows).toHaveBeenCalledWith(0, [0, 3], 'down');
    expect(selection.validSelection!.rows).toEqual([1, 4]);
    ops.moveStepRows.mockClear();
    selection.place(0, 13);
    selection.toggleRow(0, 15); // rows 13,15 — last === patternLength-1
    run(byId(cmds, 'tracker.moveDown'));
    expect(ops.moveStepRows).not.toHaveBeenCalled();
  });

  it('gapped mute passes the exact member rows', () => {
    selection.place(0, 2);
    selection.toggleRow(0, 5);
    run(byId(cmds, 'tracker.toggleMute'));
    expect(ops.toggleMuteRows).toHaveBeenCalledWith(0, [2, 5]);
  });
```

- [ ] **Step 6: Delete the superseded producers, tests, barrel names, and transitional fields**

- `packages/client/src/project/mutations.ts`: delete the functions `clearRangeDraft`, `pasteStepsDraft`, `toggleMuteRangeDraft`, `moveRangeDraft` (and their doc comments).
- `packages/client/src/project/mutations.test.ts`: delete the describes `clearRangeDraft`, `pasteStepsDraft`, `toggleMuteRangeDraft`, `moveRangeDraft`.
- `packages/client/src/project/index.ts` line 14 becomes:

```ts
export { clearTrackDraft, shiftTrackDraft, fillTrackDraft, toggleMuteRowsDraft, clearRowsDraft, pasteCellsDraft, moveRowsDraft } from './mutations';
```

- `packages/client/src/stores/selection.ts`: delete the `start` and `end` members from the `ValidSelection` interface (and the TRANSITIONAL doc line) and the `start: rows[0], end: rows[rows.length - 1],` lines from the computed's return object.

- [ ] **Step 7: Full client suite + typecheck**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client`
Expected: all tests pass (typecheck is the proof no consumer still reads `s.start`/`s.end` or the old ops/producers).

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/stores/stepClipboard.ts packages/client/src/stores/stepClipboard.test.ts packages/client/src/app/projectOps.ts packages/client/src/app/projectOps.test.ts packages/client/src/keyboard/trackerCommands.ts packages/client/src/keyboard/trackerCommands.test.ts packages/client/src/project/mutations.ts packages/client/src/project/mutations.test.ts packages/client/src/project/index.ts packages/client/src/stores/selection.ts
git commit -m "feat(client): rows-based ops + transparent gapped clipboard for multi-select

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 4: Cmd/Ctrl+click gesture in Tracker.vue

**Files:**
- Modify: `packages/client/src/components/Tracker.vue:317-332` (`onStepPointerDown`)
- Test: `packages/client/src/components/Tracker.test.ts` (append inside `describe('step selection UI')`)

**Interfaces:**
- Consumes: `selection.toggleRow(tid, row)` and `selection.isSelected(tid, row)` from Task 2.
- Produces: the user-facing gesture; nothing downstream consumes it.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('step selection UI')` in `packages/client/src/components/Tracker.test.ts` (uses the existing `ptr` and `mockStepsGeometry` helpers):

```ts
  it('cmd+pointerdown toggles rows in and out of the selection', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[5].dispatchEvent(ptr('pointerdown', { metaKey: true }));
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 5]);
    cells[5].dispatchEvent(ptr('pointerdown', { metaKey: true })); // toggle off
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2]);
  });

  it('ctrl+pointerdown does the same (windows/linux)', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[5].dispatchEvent(ptr('pointerdown', { ctrlKey: true }));
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 5]);
  });

  it('cmd+drag extends the fresh active segment; earlier rows persist', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[8].dispatchEvent(ptr('pointerdown', { metaKey: true }));
    steps.dispatchEvent(ptr('pointermove', { clientY: 10 * 22 + 10 })); // row 10
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 8, 9, 10]);
    expect(selection.validSelection!.head).toBe(10);
  });

  it('cmd toggle-off does not start a drag', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[4].dispatchEvent(ptr('pointerdown', { shiftKey: true })); // 2..4
    cells[3].dispatchEvent(ptr('pointerdown', { metaKey: true })); // toggle 3 off
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 4]);
    steps.dispatchEvent(ptr('pointermove', { clientY: 8 * 22 + 10 })); // must not extend
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 4]);
  });

  it('plain pointerdown collapses a gapped selection to the clicked row', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[6].dispatchEvent(ptr('pointerdown', { metaKey: true }));
    cells[9].dispatchEvent(ptr('pointerdown'));
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([9]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -w @fiddle/client -- src/components/Tracker.test.ts`
Expected: FAIL — cmd+pointerdown currently hits the `place` branch, so rows become `[5]` instead of `[2, 5]`.

- [ ] **Step 3: Implement the gesture branch**

In `packages/client/src/components/Tracker.vue`, replace the selection branch of `onStepPointerDown` (currently lines 317–321, through the `else selection.place(...)` line) with:

```ts
function onStepPointerDown(e: PointerEvent, row: number): void {
  if (e.button !== 0) return;
  e.preventDefault(); // no native text-selection/focus side effects
  if (e.metaKey || e.ctrlKey) {
    // Cmd (mac) / Ctrl (win+linux): toggle the row. A toggle-ON starts a new
    // active segment, so the drag machinery below may extend it (ctrl+drag
    // adds-a-range, Excel style); a toggle-OFF must not start a drag — and
    // must kill any drag already in flight, or a stale dragPointerId would
    // keep extending from the removed row. macOS Ctrl+click arrives as
    // button 2, so it never reaches this branch.
    selection.toggleRow(props.trackId, row);
    if (!selection.isSelected(props.trackId, row)) {
      dragPointerId = null;
      lastDragRow = null;
      return;
    }
  } else if (e.shiftKey) {
    selection.extendTo(props.trackId, row);
  } else {
    selection.place(props.trackId, row);
  }
```

(The remainder of the function — pointer capture, `dragPointerId`, `lastDragRow` — is unchanged.)

Also update the comment block above `const selection = useSelectionStore();` (lines 306–311) to mention the third gesture; replace its first sentence with:

```ts
// Row selection (keyboard copy/cut/clear/paste). The step-number cell is the
// selection handle: press places, shift+press extends the active segment,
// cmd/ctrl+press toggles the row (multi-select), and dragging while the
// button is held live-extends. Pointer capture on the steps container
```

- [ ] **Step 4: Run the component tests**

Run: `npm run test -w @fiddle/client -- src/components/Tracker.test.ts`
Expected: PASS (new and existing).

- [ ] **Step 5: Full client suite + typecheck**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client`
Expected: all pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/Tracker.vue packages/client/src/components/Tracker.test.ts
git commit -m "feat(client): cmd/ctrl+click toggles step rows — multi-select gesture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Final gates (controller, after all tasks)

- [ ] Full monorepo gate: `npm run test -w @fiddle/shared` (240), `npm run test -w @fiddle/client`, `npm run test -w @fiddle/server` (174), `npm run typecheck -w @fiddle/client`, `npm run build -w @fiddle/client` — all green.
- [ ] Final whole-branch code review (opus), findings addressed.
- [ ] **Mandatory browser verification** on the user's running dev:obs stack (throwaway session; close the browser when done; console clean except the two known local-env errors — favicon 404 and `/api/presets` 500):
  - Build a gapped selection with cmd+click in both layouts (overview + focused); `.selected` renders on exactly the chosen rows, `.sel-cursor` on the head.
  - Cmd+click a selected row off; cursor follows the spec rule.
  - `M` flips only the selected rows; `M` again restores.
  - Copy a gapped constellation; paste over a region with existing notes — holes leave destination rows intact; selection mirrors the paste.
  - Cut a gapped selection — gap rows untouched.
  - Alt+↓/↑ walks the constellation past unselected neighbors (displaced rows jump through, per the worked example); hold for key repeat + auto-scroll at pattern length 32; clamps at both edges.
  - Shift+click and shift+arrow after cmd+click extend only the active segment; earlier rows persist.
  - Plain click and Escape reset; click outside deselects; reload persists step edits (selection itself is local and gone — expected).
  - Cmd+click while a modal is open stands down; typing `m` in the rename input types normally.
- [ ] Update `.superpowers/sdd/progress.md` ledger + memory; present finishing options.
