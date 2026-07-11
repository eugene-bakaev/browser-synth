# Step Mute-Toggle + Move-Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new tracker keyboard commands: `M` flips `muted` per selected step; `Alt+ArrowUp`/`Alt+ArrowDown` moves the selected block one row, IDE move-line style, with the selection following.

**Architecture:** Both commands are pure extensions of the merged 4-layer keyboard system: a binding row (`bindings.ts`) → an existing-dispatch command (`trackerCommands.ts`) → a projectOps op → a pure draft producer (`project/mutations.ts`) diffed against live steps by `dispatchStepsRange` (only changed leaves dispatch, each with priorValue). Zero changes to shared, server, stores, KeyboardService, or components.

**Tech Stack:** Vue 3 + Pinia client, Vitest (jsdom for command tests), TypeScript. Spec: `docs/superpowers/specs/2026-07-11-step-mute-move-design.md` (approved).

## Global Constraints

- **Zero shared/server/store/KeyboardService/component changes** — only the six client files listed in the tasks are touched.
- Mute is a **per-step flip** (mixed selections stay mixed, inverted); rests are included (spec decision 1).
- Move **clamps at the pattern-window edges**: up at `start === 0` and down at `end === patternLength - 1` are complete no-ops — nothing dispatched, selection unchanged (spec decision 2).
- Bindings are exactly `'tracker.toggleMute': 'm'`, `'tracker.moveUp': 'alt+arrowup'`, `'tracker.moveDown': 'alt+arrowdown'` (spec decision 3).
- Move commands have `allowRepeat: true`; toggleMute does not. All three require a selection (`isEnabled: hasSelection`) (spec decision 4).
- The selection follows a moved block **preserving orientation** — anchor and head both shift by ±1 (spec decision 5).
- Run tests from the repo root with the exact commands given in each step.
- Commits: stage ONLY the named files (never `git add -A`/`-u`); end every commit message with the two trailer lines shown in the commit steps.

---

### Task 1: Pure draft producers — `toggleMuteRangeDraft` + `moveRangeDraft`

**Files:**
- Modify: `packages/client/src/project/mutations.ts` (append after `pasteStepsDraft`, line 54)
- Modify: `packages/client/src/project/index.ts` (extend the mutations re-export line)
- Test: `packages/client/src/project/mutations.test.ts` (append after the `pasteStepsDraft` describe block)

**Interfaces:**
- Consumes: `Step` type from `@fiddle/shared` (already imported in both files); `freshTrack` from `./factory` (already imported in the test file).
- Produces (Task 2 relies on these exact signatures):
  - `toggleMuteRangeDraft(steps: readonly Step[], start: number, end: number): Step[]`
  - `moveRangeDraft(steps: readonly Step[], start: number, end: number, direction: 'up' | 'down'): Step[]`
  - `moveRangeDraft` returns ONLY the affected window: up → rows `[start-1..end]` ordered `[block rows..., displaced old start-1 row]`; down → rows `[start..end+1]` ordered `[displaced old end+1 row, block rows...]`. Missing neighbor (defensive) → `[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/project/mutations.test.ts` (also add `toggleMuteRangeDraft, moveRangeDraft` to the existing import from `./mutations` on line 4):

```ts
describe('toggleMuteRangeDraft', () => {
  it('flips each step independently (mixed stays mixed, inverted)', () => {
    const t = freshTrack();
    t.steps[2].muted = true; t.steps[2].note = 'C';
    t.steps[3].muted = false; t.steps[3].note = 'D';
    const draft = toggleMuteRangeDraft(t.steps, 2, 4);
    expect(draft.map((s) => s.muted)).toEqual([false, true, true]);
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', null]); // other fields untouched
  });

  it('includes rests, returns copies, and never mutates the input', () => {
    const t = freshTrack();
    const draft = toggleMuteRangeDraft(t.steps, 0, 0);
    expect(draft[0].muted).toBe(true); // rest flipped too
    expect(draft[0]).not.toBe(t.steps[0]);
    expect(t.steps[0].muted).toBe(false);
  });
});

describe('moveRangeDraft', () => {
  // Distinct note markers: row1='A' row2='C' row3='D' row4='E' row5='F'
  function marked(): Step[] {
    const t = freshTrack();
    t.steps[1].note = 'A'; t.steps[2].note = 'C'; t.steps[3].note = 'D';
    t.steps[4].note = 'E'; t.steps[5].note = 'F';
    return t.steps;
  }

  it('up: returns rows [start-1..end] = block first, displaced row last', () => {
    // Moving [2..4] up -> rows 1..4 become [old2, old3, old4, old1]
    const draft = moveRangeDraft(marked(), 2, 4, 'up');
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', 'E', 'A']);
  });

  it('down: returns rows [start..end+1] = displaced row first, block after', () => {
    // Moving [2..4] down -> rows 2..5 become [old5, old2, old3, old4]
    const draft = moveRangeDraft(marked(), 2, 4, 'down');
    expect(draft.map((s) => s.note)).toEqual(['F', 'C', 'D', 'E']);
  });

  it('single-row block moves both directions', () => {
    expect(moveRangeDraft(marked(), 2, 2, 'up').map((s) => s.note)).toEqual(['C', 'A']);
    expect(moveRangeDraft(marked(), 2, 2, 'down').map((s) => s.note)).toEqual(['D', 'C']);
  });

  it('returns copies, never references into the input array', () => {
    const steps = marked();
    for (const row of moveRangeDraft(steps, 2, 4, 'up')) {
      expect(steps.includes(row as Step)).toBe(false);
    }
  });

  it('defensive: missing neighbor returns [] (up at row 0, down at the buffer end)', () => {
    const steps = marked();
    expect(moveRangeDraft(steps, 0, 2, 'up')).toEqual([]);
    expect(moveRangeDraft(steps, 62, 63, 'down')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @fiddle/client -- run src/project/mutations.test.ts`
Expected: FAIL — `toggleMuteRangeDraft` / `moveRangeDraft` are not exported.

- [ ] **Step 3: Implement the producers**

Append to `packages/client/src/project/mutations.ts`:

```ts
/** Copies of steps[start..end] with `muted` inverted per step (rests included). */
export function toggleMuteRangeDraft(
  steps: readonly Step[],
  start: number,
  end: number,
): Step[] {
  return steps.slice(start, end + 1).map((s) => ({ ...s, muted: !s.muted }));
}

// IDE move-line over the steps buffer: the block [start..end] shifts one row
// toward `direction` and the displaced neighbor row jumps to the block's
// other side. Returns ONLY the affected window:
//   up   -> rows [start-1 .. end]  = [block rows..., old start-1 row]
//   down -> rows [start .. end+1]  = [old end+1 row, block rows...]
// Precondition (caller-enforced clamp): the neighbor row exists in the
// pattern window. A violated precondition returns [] so nothing dispatches.
export function moveRangeDraft(
  steps: readonly Step[],
  start: number,
  end: number,
  direction: 'up' | 'down',
): Step[] {
  const block = steps.slice(start, end + 1).map((s) => ({ ...s }));
  if (direction === 'up') {
    if (start <= 0) return [];
    return [...block, { ...steps[start - 1] }];
  }
  if (end >= steps.length - 1) return [];
  return [{ ...steps[end + 1] }, ...block];
}
```

Also update the mutations re-export in `packages/client/src/project/index.ts` (Task 2's consumer imports from this barrel):

```ts
export { clearTrackDraft, shiftTrackDraft, fillTrackDraft, clearRangeDraft, pasteStepsDraft, toggleMuteRangeDraft, moveRangeDraft } from './mutations';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @fiddle/client -- run src/project/mutations.test.ts`
Expected: PASS (all describe blocks, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/project/mutations.ts packages/client/src/project/index.ts packages/client/src/project/mutations.test.ts
git commit -m "feat(client): toggleMuteRangeDraft + moveRangeDraft step producers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 2: Ops, bindings, and tracker commands

**Files:**
- Modify: `packages/client/src/app/projectOps.ts` (import line 18; ops object, after `pasteSteps` ~line 242)
- Modify: `packages/client/src/keyboard/bindings.ts` (the `KEY_BINDINGS` table)
- Modify: `packages/client/src/keyboard/trackerCommands.ts` (`TrackerCommandDeps.ops` + 3 new commands)
- Test: `packages/client/src/keyboard/trackerCommands.test.ts`

**Interfaces:**
- Consumes (from Task 1, re-exported by the `'../project'` barrel that projectOps already imports draft producers from at lines 17-20):
  - `toggleMuteRangeDraft(steps: readonly Step[], start: number, end: number): Step[]`
  - `moveRangeDraft(steps: readonly Step[], start: number, end: number, direction: 'up' | 'down'): Step[]` — window ordering: up → dispatch at `start-1`, down → dispatch at `start`.
- Produces:
  - projectOps ops object gains `toggleMuteRange(trackId: number, start: number, end: number): void` and `moveStepRange(trackId: number, start: number, end: number, direction: 'up' | 'down'): void`.
  - Commands `tracker.toggleMute`, `tracker.moveUp`, `tracker.moveDown` registered by `createTrackerCommands`.

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/keyboard/trackerCommands.test.ts`:

1. Extend the `ops` mock type (lines 23-26) to:

```ts
  let ops: {
    clearStepRange: Mock<(trackId: number, start: number, end: number) => void>;
    pasteSteps: Mock<(trackId: number, cursor: number, rows: readonly Step[]) => number>;
    toggleMuteRange: Mock<(trackId: number, start: number, end: number) => void>;
    moveStepRange: Mock<(trackId: number, start: number, end: number, direction: 'up' | 'down') => void>;
  };
```

2. Extend the `beforeEach` ops literal (line 35) to:

```ts
    ops = { clearStepRange: vi.fn(), pasteSteps: vi.fn(() => 0), toggleMuteRange: vi.fn(), moveStepRange: vi.fn() };
```

3. Extend BOTH bare ops literals in the "bindings hygiene" (line 148) and "end-to-end keydown flow" (line 173) describes to:

```ts
      ops: { clearStepRange: () => {}, pasteSteps: () => 0, toggleMuteRange: () => {}, moveStepRange: () => {} },
```

4. In the repeat-flags test (lines 130-137), add `'tracker.moveUp', 'tracker.moveDown'` to the `allowRepeat === true` list and `'tracker.toggleMute'` to the not-repeat list:

```ts
  it('cursor/extend/move commands allow key repeat; clipboard ops and mute do not', () => {
    for (const id of ['tracker.cursorUp', 'tracker.cursorDown', 'tracker.extendUp', 'tracker.extendDown', 'tracker.moveUp', 'tracker.moveDown']) {
      expect(byId(cmds, id).allowRepeat).toBe(true);
    }
    for (const id of ['tracker.copy', 'tracker.cut', 'tracker.clear', 'tracker.paste', 'tracker.toggleMute']) {
      expect(byId(cmds, id).allowRepeat).not.toBe(true);
    }
  });
```

5. Append these tests inside the main `describe('trackerCommands', ...)` block:

```ts
  it('toggleMute: disabled without selection; flips the selected range; selection stays', () => {
    expect(byId(cmds, 'tracker.toggleMute').isEnabled!()).toBe(false);
    selection.place(0, 2);
    selection.extendTo(0, 4);
    run(byId(cmds, 'tracker.toggleMute'));
    expect(ops.toggleMuteRange).toHaveBeenCalledWith(0, 2, 4);
    expect(selection.validSelection).toEqual({ trackId: 0, start: 2, end: 4, head: 4 });
  });

  it('moveUp at row 0 and moveDown at the pattern end are complete no-ops', () => {
    expect(byId(cmds, 'tracker.moveUp').isEnabled!()).toBe(false);
    selection.place(0, 0);
    selection.extendTo(0, 2);
    run(byId(cmds, 'tracker.moveUp'));
    expect(ops.moveStepRange).not.toHaveBeenCalled();
    expect(selection.validSelection).toEqual({ trackId: 0, start: 0, end: 2, head: 2 });
    selection.place(0, 14);
    selection.extendTo(0, 15); // patternLength is 16 (beforeEach)
    run(byId(cmds, 'tracker.moveDown'));
    expect(ops.moveStepRange).not.toHaveBeenCalled();
    expect(selection.validSelection).toEqual({ trackId: 0, start: 14, end: 15, head: 15 });
  });

  it('moveDown mid-track: dispatches the op and the selection follows, head still on the bottom end', () => {
    selection.place(0, 2);
    selection.extendTo(0, 4); // anchor 2, head 4 -> head === end
    run(byId(cmds, 'tracker.moveDown'));
    expect(ops.moveStepRange).toHaveBeenCalledWith(0, 2, 4, 'down');
    expect(selection.validSelection).toEqual({ trackId: 0, start: 3, end: 5, head: 5 });
  });

  it('moveUp with the head at the TOP of the block keeps the cursor on the top end', () => {
    selection.place(0, 4);
    selection.extendTo(0, 2); // anchor 4, head 2 -> head === start
    run(byId(cmds, 'tracker.moveUp'));
    expect(ops.moveStepRange).toHaveBeenCalledWith(0, 2, 4, 'up');
    expect(selection.validSelection).toEqual({ trackId: 0, start: 1, end: 3, head: 1 });
  });
```

The existing "bindings hygiene" test automatically covers the three new binding rows once they exist (every `tracker.*` binding must have a registered command, and registration must not throw a conflict).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @fiddle/client -- run src/keyboard/trackerCommands.test.ts`
Expected: FAIL — `missing command tracker.toggleMute` (and TS errors about the ops literals until the deps interface is extended; that's fine, proceed).

- [ ] **Step 3: Implement bindings, ops, and commands**

**`packages/client/src/keyboard/bindings.ts`** — the table becomes (three new rows, alphabetical order kept):

```ts
export const KEY_BINDINGS: Record<string, string | readonly string[]> = {
  'tracker.clear': ['delete', 'backspace'],
  'tracker.copy': 'mod+c',
  'tracker.cursorDown': 'arrowdown',
  'tracker.cursorUp': 'arrowup',
  'tracker.cut': 'mod+x',
  'tracker.deselect': 'escape',
  'tracker.extendDown': 'shift+arrowdown',
  'tracker.extendUp': 'shift+arrowup',
  'tracker.moveDown': 'alt+arrowdown',
  'tracker.moveUp': 'alt+arrowup',
  'tracker.paste': 'mod+v',
  'tracker.toggleMute': 'm',
};
```

**`packages/client/src/app/projectOps.ts`** — add `toggleMuteRangeDraft, moveRangeDraft` to the existing mutations import (line 18), then add to the returned ops object, directly after `pasteSteps`:

```ts
    /** Per-step mute flip over [start, end] (spec: mixed selections invert per step). */
    toggleMuteRange(trackId: number, start: number, end: number): void {
      const t = project.tracks[trackId];
      dispatchStepsRange(trackId, start, toggleMuteRangeDraft(t.steps, start, end) as unknown as Record<string, unknown>[]);
    },
    /** IDE move-line: shifts [start..end] one row toward `direction`; the displaced
     *  neighbor jumps to the block's other side. Caller clamps at the window edges. */
    moveStepRange(trackId: number, start: number, end: number, direction: 'up' | 'down'): void {
      const t = project.tracks[trackId];
      const windowStart = direction === 'up' ? start - 1 : start;
      dispatchStepsRange(trackId, windowStart, moveRangeDraft(t.steps, start, end, direction) as unknown as Record<string, unknown>[]);
    },
```

**`packages/client/src/keyboard/trackerCommands.ts`** — extend the ops interface in `TrackerCommandDeps` (lines 13-16) to:

```ts
  ops: {
    clearStepRange(trackId: number, start: number, end: number): void;
    pasteSteps(trackId: number, cursor: number, rows: readonly Step[]): number;
    toggleMuteRange(trackId: number, start: number, end: number): void;
    moveStepRange(trackId: number, start: number, end: number, direction: 'up' | 'down'): void;
  };
```

Add this helper inside `createTrackerCommands`, after `moveOrSeed`:

```ts
  // Alt+arrow move: clamp at the pattern-window edge (spec: complete no-op,
  // nothing dispatched), then move the block and carry the selection with it,
  // preserving which end holds the cursor.
  function moveSelection(direction: 'up' | 'down'): void {
    const s = sel();
    if (!s) return;
    const max = project.tracks[s.trackId].patternLength - 1;
    if (direction === 'up' ? s.start === 0 : s.end === max) return;
    ops.moveStepRange(s.trackId, s.start, s.end, direction);
    const delta = direction === 'up' ? -1 : 1;
    const [anchorRow, headRow] = s.head === s.end ? [s.start, s.end] : [s.end, s.start];
    selection.place(s.trackId, anchorRow + delta);
    selection.extendTo(s.trackId, headRow + delta);
  }
```

Append three entries to the returned command array (after `tracker.deselect`):

```ts
    {
      id: 'tracker.toggleMute',
      description: 'Toggle mute on selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: () => {
        const s = sel();
        if (!s) return;
        ops.toggleMuteRange(s.trackId, s.start, s.end);
      },
    },
    {
      id: 'tracker.moveUp',
      description: 'Move selected steps up',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: hasSelection,
      run: () => moveSelection('up'),
    },
    {
      id: 'tracker.moveDown',
      description: 'Move selected steps down',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: hasSelection,
      run: () => moveSelection('down'),
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @fiddle/client -- run src/keyboard/trackerCommands.test.ts src/project/mutations.test.ts`
Expected: PASS (all tests, including hygiene + e2e describes).

- [ ] **Step 5: Full client gate**

Run: `npm run test -w @fiddle/client -- run && npm run typecheck -w @fiddle/client`
Expected: full suite PASS; vue-tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/keyboard/bindings.ts packages/client/src/keyboard/trackerCommands.ts packages/client/src/keyboard/trackerCommands.test.ts packages/client/src/app/projectOps.ts
git commit -m "feat(client): M mute-toggle + alt+arrow move-selection tracker commands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

## Final gates (controller, after both tasks + final review)

1. Full monorepo gate: `npm run test -w @fiddle/shared -- run && npm run test -w @fiddle/client -- run && npm run test -w @fiddle/server -- run && npm run typecheck -w @fiddle/client && npm run build -w @fiddle/client`.
2. **Mandatory browser verification** on `npm run dev:obs` (LOCAL Docker DB — NEVER `npm run dev`), throwaway session, per the spec checklist: M on a mixed selection flips per-step in both layouts and restores on second press; Alt+↑/↓ walks a marked block past neighbor rows (displaced row jumps to the other side); edge clamps at row 0 / pattern end; held-repeat at length 32 with auto-scroll following; shift+arrow extends from the same head after a move; reload persists moved/muted steps; M inside the rename input types "m"; keys stand down behind an open modal. Clean console (favicon 404 tolerated); close the browser session.
