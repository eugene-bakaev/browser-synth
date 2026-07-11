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
