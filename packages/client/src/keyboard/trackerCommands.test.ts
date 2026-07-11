// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { freshProject, type Step } from '@fiddle/shared';
import { useProjectStore } from '../stores/project';
import { useSelectionStore } from '../stores/selection';
import { useStepClipboardStore } from '../stores/stepClipboard';
import { createTrackerCommands, type TrackerCommandDeps } from './trackerCommands';
import { KeyboardService, type KeyboardCommand } from './KeyboardService';
import { KEY_BINDINGS } from './bindings';

function byId(cmds: KeyboardCommand[], id: string): KeyboardCommand {
  const c = cmds.find((x) => x.id === id);
  if (!c) throw new Error(`missing command ${id}`);
  return c;
}
const run = (c: KeyboardCommand) => c.run(new KeyboardEvent('keydown'));

describe('trackerCommands', () => {
  let selection: ReturnType<typeof useSelectionStore>;
  let clipboard: ReturnType<typeof useStepClipboardStore>;
  let projectStore: ReturnType<typeof useProjectStore>;
  let ops: {
    clearStepRange: Mock<(trackId: number, start: number, end: number) => void>;
    pasteSteps: Mock<(trackId: number, cursor: number, rows: readonly Step[]) => number>;
    toggleMuteRange: Mock<(trackId: number, start: number, end: number) => void>;
    moveStepRange: Mock<(trackId: number, start: number, end: number, direction: 'up' | 'down') => void>;
  };
  let focused: number | null;
  let cmds: KeyboardCommand[];

  beforeEach(() => {
    setActivePinia(createPinia());
    projectStore = useProjectStore();
    selection = useSelectionStore();
    clipboard = useStepClipboardStore();
    ops = { clearStepRange: vi.fn(), pasteSteps: vi.fn(() => 0), toggleMuteRange: vi.fn(), moveStepRange: vi.fn() };
    focused = null;
    const deps: TrackerCommandDeps = {
      selection, clipboard,
      project: projectStore.project,
      ops,
      focusedTrackId: () => focused,
    };
    cmds = createTrackerCommands(deps);
    projectStore.project.tracks[0].patternLength = 16;
    projectStore.project.tracks[0].steps[2].note = 'C';
    projectStore.project.tracks[0].steps[3].note = 'D';
  });

  it('enablement matrix: copy/cut/clear need a selection; paste needs selection AND clipboard', () => {
    for (const id of ['tracker.copy', 'tracker.cut', 'tracker.clear', 'tracker.paste']) {
      expect(byId(cmds, id).isEnabled!()).toBe(false);
    }
    selection.place(0, 2);
    expect(byId(cmds, 'tracker.copy').isEnabled!()).toBe(true);
    expect(byId(cmds, 'tracker.paste').isEnabled!()).toBe(false);
    clipboard.set([projectStore.project.tracks[0].steps[2]]);
    expect(byId(cmds, 'tracker.paste').isEnabled!()).toBe(true);
  });

  it('copy snapshots the selected rows into the clipboard', () => {
    selection.place(0, 2);
    selection.extendTo(0, 3);
    run(byId(cmds, 'tracker.copy'));
    expect(clipboard.rows!.map((s) => s.note)).toEqual(['C', 'D']);
  });

  it('cut = copy + clearStepRange; selection stays', () => {
    selection.place(0, 2);
    selection.extendTo(0, 3);
    run(byId(cmds, 'tracker.cut'));
    expect(clipboard.rows!.map((s) => s.note)).toEqual(['C', 'D']);
    expect(ops.clearStepRange).toHaveBeenCalledWith(0, 2, 3);
    expect(selection.validSelection).toEqual({ trackId: 0, start: 2, end: 3, head: 3 });
  });

  it('clear clears without touching the clipboard', () => {
    selection.place(0, 2);
    run(byId(cmds, 'tracker.clear'));
    expect(ops.clearStepRange).toHaveBeenCalledWith(0, 2, 2);
    expect(clipboard.rows).toBeNull();
  });

  it('paste pastes at the selection start and re-selects the written range', () => {
    clipboard.set([projectStore.project.tracks[0].steps[2], projectStore.project.tracks[0].steps[3]]);
    ops.pasteSteps.mockReturnValue(2);
    selection.place(0, 8);
    run(byId(cmds, 'tracker.paste'));
    expect(ops.pasteSteps).toHaveBeenCalledWith(0, 8, clipboard.rows);
    expect(selection.validSelection).toEqual({ trackId: 0, start: 8, end: 9, head: 9 });
  });

  it('paste that writes 0 rows leaves the selection alone', () => {
    clipboard.set([projectStore.project.tracks[0].steps[2]]);
    ops.pasteSteps.mockReturnValue(0);
    selection.place(0, 8);
    run(byId(cmds, 'tracker.paste'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 8, end: 8, head: 8 });
  });

  it('cursor commands: seed at row 0 of the focused track when no selection exists', () => {
    focused = 0;
    expect(byId(cmds, 'tracker.cursorDown').isEnabled!()).toBe(true);
    run(byId(cmds, 'tracker.cursorDown'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 0, end: 0, head: 0 });
  });

  it('cursor commands: disabled with no selection and no focused track', () => {
    expect(byId(cmds, 'tracker.cursorDown').isEnabled!()).toBe(false);
    expect(byId(cmds, 'tracker.extendDown').isEnabled!()).toBe(false);
  });

  it('cursor moves and extends once a selection exists', () => {
    selection.place(0, 5);
    run(byId(cmds, 'tracker.cursorDown'));
    expect(selection.validSelection!.head).toBe(6);
    run(byId(cmds, 'tracker.extendDown'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 6, end: 7, head: 7 });
    run(byId(cmds, 'tracker.cursorUp'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 6, end: 6, head: 6 });
  });

  it('deselect clears; enabled only while something is selected', () => {
    expect(byId(cmds, 'tracker.deselect').isEnabled!()).toBe(false);
    selection.place(0, 5);
    expect(byId(cmds, 'tracker.deselect').isEnabled!()).toBe(true);
    run(byId(cmds, 'tracker.deselect'));
    expect(selection.trackId).toBeNull();
  });

  it('cursor/extend/move commands allow key repeat; clipboard ops and mute do not', () => {
    for (const id of ['tracker.cursorUp', 'tracker.cursorDown', 'tracker.extendUp', 'tracker.extendDown', 'tracker.moveUp', 'tracker.moveDown']) {
      expect(byId(cmds, id).allowRepeat).toBe(true);
    }
    for (const id of ['tracker.copy', 'tracker.cut', 'tracker.clear', 'tracker.paste', 'tracker.toggleMute']) {
      expect(byId(cmds, id).allowRepeat).not.toBe(true);
    }
  });

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
});

describe('bindings hygiene', () => {
  it('registering the full command set has no conflicts, and every tracker.* binding has a command', () => {
    setActivePinia(createPinia());
    const projectStore = useProjectStore();
    const deps: TrackerCommandDeps = {
      selection: useSelectionStore(),
      clipboard: useStepClipboardStore(),
      project: projectStore.project,
      ops: { clearStepRange: () => {}, pasteSteps: () => 0, toggleMuteRange: () => {}, moveStepRange: () => {} },
      focusedTrackId: () => null,
    };
    const cmds = createTrackerCommands(deps);
    const service = new KeyboardService({ platform: 'mac', target: null });
    expect(() => { for (const c of cmds) service.register(c); }).not.toThrow();
    const ids = new Set(cmds.map((c) => c.id));
    for (const id of Object.keys(KEY_BINDINGS)) {
      if (id.startsWith('tracker.')) expect(ids.has(id), `binding ${id} has no command`).toBe(true);
    }
    service.dispose();
  });
});

describe('end-to-end keydown flow (service + stores + commands)', () => {
  it('mod+c on a selection copies; escape deselects; keys in an input do nothing', () => {
    setActivePinia(createPinia());
    const projectStore = useProjectStore();
    const selection = useSelectionStore();
    const clipboard = useStepClipboardStore();
    projectStore.project.tracks[0].patternLength = 16;
    projectStore.project.tracks[0].steps[1].note = 'F';
    const cmds = createTrackerCommands({
      selection, clipboard,
      project: projectStore.project,
      ops: { clearStepRange: () => {}, pasteSteps: () => 0, toggleMuteRange: () => {}, moveStepRange: () => {} },
      focusedTrackId: () => null,
    });
    const service = new KeyboardService({ platform: 'mac', target: null });
    for (const c of cmds) service.register(c);

    selection.place(0, 1);
    service.handleKeydown(new KeyboardEvent('keydown', { key: 'c', metaKey: true, cancelable: true }));
    expect(clipboard.rows!.map((s) => s.note)).toEqual(['F']);

    // keydown originating from an input is fully ignored
    const input = document.createElement('input');
    document.body.appendChild(input);
    const fromInput = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(fromInput);
    service.handleKeydown(fromInput);
    expect(selection.trackId).toBe(0);
    input.remove();

    service.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(selection.trackId).toBeNull();
    service.dispose();
  });
});
