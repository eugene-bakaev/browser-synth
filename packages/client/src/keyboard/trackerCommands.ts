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
    clearStepRange(trackId: number, start: number, end: number): void;
    pasteSteps(trackId: number, cursor: number, rows: readonly Step[]): number;
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
    clipboard.set(project.tracks[s.trackId].steps.slice(s.start, s.end + 1));
  }

  // Arrows: move the cursor when a selection exists; otherwise, in the
  // focused view, seed it at row 0 (keyboard-only entry — spec).
  function moveOrSeed(delta: number): void {
    if (sel()) { selection.moveCursor(delta); return; }
    const focused = focusedTrackId();
    if (focused !== null) selection.place(focused, 0);
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
        ops.clearStepRange(s.trackId, s.start, s.end);
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
        ops.clearStepRange(s.trackId, s.start, s.end);
      },
    },
    {
      id: 'tracker.paste',
      description: 'Paste steps at the selection',
      context: 'tracker',
      isEnabled: () => (clipboard.rows?.length ?? 0) > 0 && hasSelection(),
      run: () => {
        const s = sel();
        const rows = clipboard.rows;
        if (!s || !rows || rows.length === 0) return;
        // Paste target = top of the selection (== the cursor for a collapsed
        // selection). The op clips at the pattern window and reports back.
        const written = ops.pasteSteps(s.trackId, s.start, rows);
        if (written > 0) {
          selection.place(s.trackId, s.start);
          selection.extendTo(s.trackId, s.start + written - 1);
        }
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
  ];
}
