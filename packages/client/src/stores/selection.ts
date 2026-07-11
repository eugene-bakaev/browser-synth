//
// Tracker row selection — STRICTLY LOCAL UI state. Never dispatched, never
// enqueued, never persisted; each peer has their own selection.
//
// Model (cmd+click multi-select spec): the selection is `frozen` rows —
// committed by earlier cmd+clicks — plus ONE active segment (anchor..head).
// Shift/drag gestures reshape only the active segment; cmd+click freezes it
// and starts a new one. A selection with no frozen rows is exactly the old
// single-range model.
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
  rows: readonly number[]; // sorted, deduped, clamped to the pattern window
  ranges: readonly { start: number; end: number }[]; // contiguous runs of rows
  first: number; // rows[0]
  last: number;  // rows[rows.length - 1]
  head: number;  // the cursor (the moving end of the active segment)
  /** TRANSITIONAL (Task 3 removes them): span bounds, = first/last. */
  start: number;
  end: number;
}

export const useSelectionStore = defineStore('selection', () => {
  const projectStore = useProjectStore();

  const trackId = ref<number | null>(null);
  const anchor = ref(0);
  const head = ref(0);
  const frozen = ref<Set<number>>(new Set());

  const validSelection = computed<ValidSelection | null>(() => {
    const tid = trackId.value;
    if (tid === null) return null;
    const track = projectStore.project.tracks[tid];
    if (!track || !track.enabled) return null;
    const max = track.patternLength - 1;
    const activeStart = Math.max(0, Math.min(anchor.value, head.value));
    const activeEnd = Math.min(Math.max(anchor.value, head.value), max);
    const rowSet = new Set<number>();
    for (let r = activeStart; r <= activeEnd; r++) rowSet.add(r);
    for (const r of frozen.value) if (r >= 0 && r <= max) rowSet.add(r);
    if (rowSet.size === 0) return null;
    const rows = [...rowSet].sort((a, b) => a - b);
    const ranges: { start: number; end: number }[] = [];
    for (const r of rows) {
      const run = ranges[ranges.length - 1];
      if (run && r === run.end + 1) run.end = r;
      else ranges.push({ start: r, end: r });
    }
    return {
      trackId: tid,
      rows,
      ranges,
      first: rows[0],
      last: rows[rows.length - 1],
      head: Math.min(Math.max(head.value, 0), max),
      start: rows[0],
      end: rows[rows.length - 1],
    };
  });

  const size = computed(() => validSelection.value?.rows.length ?? 0);

  const selectedRowSet = computed<Set<number>>(() => new Set(validSelection.value?.rows ?? []));

  function isSelected(tid: number, row: number): boolean {
    const s = validSelection.value;
    return s !== null && s.trackId === tid && selectedRowSet.value.has(row);
  }

  function place(tid: number, row: number): void {
    trackId.value = tid;
    anchor.value = row;
    head.value = row;
    frozen.value = new Set();
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

  /** Collapse & move: the whole selection (frozen included) collapses to
   *  clamped(head + delta). No-op without a valid selection. */
  function moveCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    const next = clampToWindow(s.head + delta);
    anchor.value = next;
    head.value = next;
    frozen.value = new Set();
  }

  /** Move only the head (Shift+arrow) — reshapes the active segment, frozen
   *  rows persist. No-op without a valid selection. */
  function extendCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    head.value = clampToWindow(s.head + delta);
  }

  /** Cmd/Ctrl+click: toggle `row` in/out of the selection.
   *  Not selected → freeze the current rows and start a new collapsed active
   *  segment at `row`. Selected → remove it; the cursor stays at the old head
   *  when the head survives, else jumps to the nearest remaining row (tie →
   *  lower); removing the only row clears. */
  function toggleRow(tid: number, row: number): void {
    const s = validSelection.value;
    if (!s || s.trackId !== tid) { place(tid, row); return; }
    if (!selectedRowSet.value.has(row)) {
      frozen.value = new Set(s.rows); // validated rows — stale entries drop here
      anchor.value = row;
      head.value = row;
      return;
    }
    const remaining = s.rows.filter((r) => r !== row);
    if (remaining.length === 0) { clear(); return; }
    const cursor = remaining.includes(s.head)
      ? s.head
      : remaining.reduce((best, r) => {
          const dr = Math.abs(r - row);
          const db = Math.abs(best - row);
          return dr < db || (dr === db && r < best) ? r : best;
        });
    frozen.value = new Set(remaining.filter((r) => r !== cursor));
    anchor.value = cursor;
    head.value = cursor;
  }

  /** Shift the whole selection by `delta` (selection-follow after a
   *  constellation move). The caller guarantees the result stays inside the
   *  pattern window; validSelection self-heals stray rows on read anyway. */
  function shiftAll(delta: number): void {
    frozen.value = new Set([...frozen.value].map((r) => r + delta));
    anchor.value += delta;
    head.value += delta;
  }

  /** Select exactly `rows` (sorted ascending, non-empty; no-op on empty):
   *  frozen = all but the last, active segment collapsed on the last. Used to
   *  mirror a pasted constellation. */
  function selectRows(tid: number, rows: readonly number[]): void {
    if (rows.length === 0) return;
    trackId.value = tid;
    frozen.value = new Set(rows.slice(0, -1));
    const last = rows[rows.length - 1];
    anchor.value = last;
    head.value = last;
  }

  function clear(): void {
    trackId.value = null;
    frozen.value = new Set();
  }

  return { trackId, anchor, head, validSelection, size, isSelected, place, extendTo, moveCursor, extendCursor, toggleRow, shiftAll, selectRows, clear };
});
