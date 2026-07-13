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
