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
