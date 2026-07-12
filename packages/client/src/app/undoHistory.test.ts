import { describe, it, expect, vi } from 'vitest';
import type { Path } from '@fiddle/shared';
import { createUndoHistory, UNDO_DEPTH, type UndoHistory } from './undoHistory';

// Microtask flush: queueMicrotask(seal) enqueued before this await resolves.
const tick = () => Promise.resolve();

// Harness mirrors the REAL wiring: `dispatch` writes state and then re-enters
// history.record (in production: bus.dispatchLocal → onLocalCommand tap), so
// the re-entrancy guard is exercised by every undo/redo test, not one.
function harness() {
  const state = new Map<string, unknown>();
  const key = (p: Path) => JSON.stringify(p);
  let history: UndoHistory;
  const dispatch = vi.fn((path: Path, value: unknown, priorValue: unknown) => {
    state.set(key(path), value);
    history.record(path, value, priorValue, true);
  });
  history = createUndoHistory({
    getLiveValue: (path) => state.get(key(path)),
    dispatch,
  });
  /** Simulate a local user edit (bus order: write state, then tap). */
  function edit(path: Path, value: unknown, gestureEnd = true): void {
    const prior = state.get(key(path));
    state.set(key(path), value);
    history.record(path, value, prior, gestureEnd);
  }
  /** Simulate a remote user's edit (applyRemote: state only, no tap). */
  function remote(path: Path, value: unknown): void {
    state.set(key(path), value);
  }
  return { state, key, dispatch, history, edit, remote };
}

describe('recording', () => {
  it('burst rule: leaves dispatched in one task form ONE entry', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0); h.state.set(h.key(['c']), 0);
    h.edit(['a'], 1); h.edit(['b'], 2); h.edit(['c'], 3); // same task
    await tick();
    expect(h.history.canUndo()).toBe(true);
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0);
    expect(h.state.get(h.key(['b']))).toBe(0);
    expect(h.state.get(h.key(['c']))).toBe(0);
    expect(h.history.canUndo()).toBe(false); // one entry, fully consumed
  });

  it('same leaf twice in one burst keeps earliest before, latest after', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); h.edit(['a'], 2);
    await tick();
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0); // not 1
    h.history.redo();
    expect(h.state.get(h.key(['a']))).toBe(2); // not 1
  });

  it('separate tasks make separate entries', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.edit(['a'], 2); await tick();
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(1);
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0);
  });

  it('no-op filter: value === priorValue records nothing', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 5);
    h.edit(['a'], 5);
    await tick();
    expect(h.history.canUndo()).toBe(false);
  });
});

describe('drag merging', () => {
  const knob: Path = ['tracks', 0, 'engines', 'synth', 'osc1Coarse'];

  it('consecutive continuous single-leaf entries on one path merge into one entry', async () => {
    const h = harness();
    h.state.set(h.key(knob), 0);
    h.edit(knob, 0.1, false); await tick();
    h.edit(knob, 0.2, false); await tick();
    h.edit(knob, 0.3, false); await tick();
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0); // whole drag = one step
    expect(h.history.canUndo()).toBe(false);
  });

  it('endGesture closes the merge window: a second drag is a second entry', async () => {
    const h = harness();
    h.state.set(h.key(knob), 0);
    h.edit(knob, 0.1, false); await tick();
    h.history.endGesture(knob);
    h.edit(knob, 0.2, false); await tick();
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0.1); // second drag undone only
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0);
  });

  it('discrete leaves (gestureEnd=true) never merge', async () => {
    const h = harness();
    h.state.set(h.key(['m']), false);
    h.edit(['m'], true); await tick();
    h.edit(['m'], false); await tick();
    h.history.undo();
    expect(h.state.get(h.key(['m']))).toBe(true);
    h.history.undo();
    expect(h.state.get(h.key(['m']))).toBe(false);
  });

  it('a different path breaks the merge chain', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0);
    h.edit(['a'], 0.1, false); await tick();
    h.edit(['b'], 0.5, false); await tick();
    h.edit(['a'], 0.2, false); await tick(); // must NOT merge into the first ['a'] entry
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0.1);
  });

  it('undo closes the merge window', async () => {
    const h = harness();
    h.state.set(h.key(knob), 0);
    h.edit(knob, 0.1, false); await tick();
    h.history.undo();                        // back to 0
    h.history.redo();                        // forward to 0.1
    h.edit(knob, 0.2, false); await tick();  // new drag — must NOT merge into old entry
    h.history.undo();
    expect(h.state.get(h.key(knob))).toBe(0.1);
  });
});

describe('undo/redo semantics', () => {
  it('skip-if-superseded: a remotely overwritten leaf is skipped, others restore', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0);
    h.edit(['a'], 1); h.edit(['b'], 2); // one entry
    await tick();
    h.remote(['b'], 99);                // collaborator wins on b
    h.history.undo();
    expect(h.state.get(h.key(['a']))).toBe(0);  // still mine → restored
    expect(h.state.get(h.key(['b']))).toBe(99); // theirs → untouched
    h.history.redo();                   // redo entry contains ONLY the applied leaf
    expect(h.state.get(h.key(['a']))).toBe(1);
    expect(h.state.get(h.key(['b']))).toBe(99);
  });

  it('fully-stale entry pops through to the next older entry', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0); h.state.set(h.key(['b']), 0);
    h.edit(['a'], 1); await tick();
    h.edit(['b'], 2); await tick();
    h.remote(['b'], 99);                // newest entry fully superseded
    h.history.undo();                   // skips b-entry, undoes a-entry
    expect(h.state.get(h.key(['b']))).toBe(99);
    expect(h.state.get(h.key(['a']))).toBe(0);
    expect(h.history.canUndo()).toBe(false); // both entries consumed
  });

  it('redo skips a leaf someone changed after the undo', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();                   // a back to 0
    h.remote(['a'], 50);
    h.history.redo();                   // live 50 !== before 0 → skip
    expect(h.state.get(h.key(['a']))).toBe(50);
  });

  it('a fresh edit clears the redo stack', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();
    expect(h.history.canRedo()).toBe(true);
    h.edit(['a'], 7); await tick();
    expect(h.history.canRedo()).toBe(false);
  });

  it('redo does NOT clear the redo stack (chained redos work)', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.edit(['a'], 2); await tick();
    h.history.undo(); h.history.undo();
    h.history.redo();
    expect(h.history.canRedo()).toBe(true);
    h.history.redo();
    expect(h.state.get(h.key(['a']))).toBe(2);
  });

  it('re-entrancy: undo/redo dispatches are not recorded as new entries', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();
    await tick(); // any illegal self-record would seal here
    expect(h.history.canUndo()).toBe(false);
    h.history.redo();
    await tick();
    expect(h.history.canRedo()).toBe(false);
    expect(h.history.canUndo()).toBe(true); // exactly the one re-pushed entry
  });

  it('undo/redo on empty stacks is a no-op', () => {
    const h = harness();
    h.history.undo();
    h.history.redo();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('depth cap: oldest entries evicted beyond UNDO_DEPTH', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    for (let i = 1; i <= UNDO_DEPTH + 5; i++) {
      h.edit(['a'], i); await tick();
    }
    let undos = 0;
    while (h.history.canUndo()) { h.history.undo(); undos++; }
    expect(undos).toBe(UNDO_DEPTH);
    expect(h.state.get(h.key(['a']))).toBe(5); // entries 1..5 were evicted
  });

  it('clear() empties both stacks and the merge window', async () => {
    const h = harness();
    h.state.set(h.key(['a']), 0);
    h.edit(['a'], 1); await tick();
    h.history.undo();
    h.history.clear();
    expect(h.history.canUndo()).toBe(false);
    expect(h.history.canRedo()).toBe(false);
  });
});
