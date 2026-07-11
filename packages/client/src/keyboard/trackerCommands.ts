// The tracker's keyboard command set: selection movement + copy/cut/clear/
// paste. A pure factory over its dependencies — no component, no service,
// no window — so the whole behavior surface is unit-testable.
import type { Project, Step } from '@fiddle/shared';
import type { KeyboardCommand } from './KeyboardService';
import type { useSelectionStore } from '../stores/selection';
import type { useStepClipboardStore } from '../stores/stepClipboard';

export interface TrackerCommandDeps {
  selection: ReturnType<typeof useSelectionStore>;
  clipboard: ReturnType<typeof useStepClipboardStore>;
  project: Project;
  ops: {
    clearStepRows(trackId: number, rows: readonly number[]): void;
    pasteSteps(trackId: number, cursor: number, cells: readonly (Step | null)[]): number[];
    toggleMuteRows(trackId: number, rows: readonly number[]): void;
    moveStepRows(trackId: number, rows: readonly number[], direction: 'up' | 'down'): void;
  };
  /** The focused-view track (StudioView's activeTrackIndex), or null in the overview. */
  focusedTrackId: () => number | null;
}

export function createTrackerCommands(deps: TrackerCommandDeps): KeyboardCommand[] {
  const { selection, clipboard, project, ops, focusedTrackId } = deps;

  const sel = () => selection.validSelection;
  const hasSelection = () => sel() !== null;

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

  // Arrows: move the cursor when a selection exists; otherwise, in the
  // focused view, seed it at row 0 (keyboard-only entry — spec).
  function moveOrSeed(delta: number): void {
    if (sel()) { selection.moveCursor(delta); return; }
    const focused = focusedTrackId();
    if (focused !== null) selection.place(focused, 0);
  }

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

  return [
    {
      id: 'tracker.copy',
      description: 'Copy selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: copySelection,
    },
    {
      id: 'tracker.cut',
      description: 'Cut selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: () => {
        const s = sel();
        if (!s) return;
        copySelection();
        ops.clearStepRows(s.trackId, s.rows);
      },
    },
    {
      id: 'tracker.clear',
      description: 'Clear selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: () => {
        const s = sel();
        if (!s) return;
        ops.clearStepRows(s.trackId, s.rows);
      },
    },
    {
      id: 'tracker.paste',
      description: 'Paste steps at the selection',
      context: 'tracker',
      isEnabled: () => (clipboard.rows?.length ?? 0) > 0 && hasSelection(),
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
    },
    {
      id: 'tracker.cursorUp',
      description: 'Move cursor up',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: () => hasSelection() || focusedTrackId() !== null,
      run: () => moveOrSeed(-1),
    },
    {
      id: 'tracker.cursorDown',
      description: 'Move cursor down',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: () => hasSelection() || focusedTrackId() !== null,
      run: () => moveOrSeed(1),
    },
    {
      id: 'tracker.extendUp',
      description: 'Extend selection up',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: hasSelection,
      run: () => selection.extendCursor(-1),
    },
    {
      id: 'tracker.extendDown',
      description: 'Extend selection down',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: hasSelection,
      run: () => selection.extendCursor(1),
    },
    {
      id: 'tracker.deselect',
      description: 'Clear selection',
      context: 'tracker',
      isEnabled: () => selection.trackId !== null,
      run: () => selection.clear(),
    },
    {
      id: 'tracker.toggleMute',
      description: 'Toggle mute on selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: () => {
        const s = sel();
        if (!s) return;
        ops.toggleMuteRows(s.trackId, s.rows);
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
  ];
}
