//
// Tracker row selection — STRICTLY LOCAL UI state. Never dispatched, never
// enqueued, never persisted; each peer has their own selection.
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
  start: number; // inclusive
  end: number;   // inclusive
  head: number;  // the cursor (the moving end of the range)
}

export const useSelectionStore = defineStore('selection', () => {
  const projectStore = useProjectStore();

  const trackId = ref<number | null>(null);
  const anchor = ref(0);
  const head = ref(0);

  const validSelection = computed<ValidSelection | null>(() => {
    const tid = trackId.value;
    if (tid === null) return null;
    const track = projectStore.project.tracks[tid];
    if (!track || !track.enabled) return null;
    const max = track.patternLength - 1;
    const start = Math.min(anchor.value, head.value);
    const end = Math.max(anchor.value, head.value);
    if (start > max || end < 0) return null;
    return {
      trackId: tid,
      start: Math.max(0, start),
      end: Math.min(end, max),
      head: Math.min(Math.max(head.value, 0), max),
    };
  });

  const size = computed(() => {
    const s = validSelection.value;
    return s ? s.end - s.start + 1 : 0;
  });

  function isSelected(tid: number, row: number): boolean {
    const s = validSelection.value;
    return s !== null && s.trackId === tid && row >= s.start && row <= s.end;
  }

  function place(tid: number, row: number): void {
    trackId.value = tid;
    anchor.value = row;
    head.value = row;
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

  /** Collapse & move: anchor = head = clamped(head + delta). No-op without a valid selection. */
  function moveCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    const next = clampToWindow(s.head + delta);
    anchor.value = next;
    head.value = next;
  }

  /** Move only the head (Shift+arrow). No-op without a valid selection. */
  function extendCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    head.value = clampToWindow(s.head + delta);
  }

  function clear(): void {
    trackId.value = null;
  }

  return { trackId, anchor, head, validSelection, size, isSelected, place, extendTo, moveCursor, extendCursor, clear };
});
