//
// In-memory step clipboard — LOCAL ONLY (never synced, never persisted; gone
// on reload). Rows are plain deep copies: every Step field is a primitive, so
// a spread per row fully detaches from the reactive source.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Step } from '@fiddle/shared';

export const useStepClipboardStore = defineStore('stepClipboard', () => {
  const rows = ref<Step[] | null>(null);

  function set(steps: readonly Step[]): void {
    rows.value = steps.map((s) => ({ ...s }));
  }

  return { rows, set };
});
