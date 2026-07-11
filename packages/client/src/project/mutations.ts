import type { Step } from '@fiddle/shared';
import { freshStep } from './factory';

// Pure draft producers (Phase 5): compute the post-op steps window WITHOUT
// mutating live state. The caller (app/projectOps) diffs draft vs live and
// dispatches each changed leaf through the CommandBus — the bus (via the
// store) is the only writer of project state.

export function clearTrackDraft(patternLength: number): Step[] {
  return Array.from({ length: patternLength }, () => freshStep());
}

export function shiftTrackDraft(
  steps: readonly Step[],
  direction: 'left' | 'right',
  patternLength: number,
): Step[] {
  const window = steps.slice(0, patternLength).map((s) => ({ ...s }));
  if (patternLength <= 1) return window;
  return window.map((_, i) =>
    direction === 'left'
      ? { ...window[(i + 1) % patternLength] }
      : { ...window[(i - 1 + patternLength) % patternLength] },
  );
}

export function fillTrackDraft(
  steps: readonly Step[],
  interval: number,
  patternLength: number,
): Step[] {
  const window = steps.slice(0, patternLength).map((s) => ({ ...s }));
  if (interval <= 0) return window; // guard against modulo-by-zero (UI only offers 1/2/4/8)
  for (let i = 0; i < patternLength; i++) {
    if (i % interval === 0) {
      Object.assign(window[i], { note: 'C', muted: false, velocity: 0.8, isChord: false, chordType: 'maj' });
    }
  }
  return window;
}

// ---- rows-based producers (gapped selections; cmd+click multi-select) ----
// `rows` is sorted ascending, deduped, non-empty (validSelection guarantees
// it). Each producer returns a span draft with gap rows copied through
// unchanged — the caller's diff (dispatchStepsRange) drops them, so only
// member rows dispatch.

/** Span draft [rows[0]..last]: member rows get `muted` inverted (rests
 *  included), gap rows copy through. Contiguous rows == old toggleMuteRangeDraft. */
export function toggleMuteRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[] {
  const first = rows[0];
  const members = new Set(rows);
  return steps.slice(first, rows[rows.length - 1] + 1).map((s, i) =>
    members.has(first + i) ? { ...s, muted: !s.muted } : { ...s },
  );
}

/** Span draft: member rows become factory-default steps, gap rows copy through. */
export function clearRowsDraft(steps: readonly Step[], rows: readonly number[]): Step[] {
  const first = rows[0];
  const members = new Set(rows);
  return steps.slice(first, rows[rows.length - 1] + 1).map((s, i) =>
    members.has(first + i) ? freshStep() : { ...s },
  );
}

/** Transparent paste: draft over [start..], clipped at the pattern window
 *  (never the 64-slot buffer). Non-null cells overwrite; null holes copy the
 *  existing destination row through, so content under a hole survives. */
export function pasteCellsDraft(
  steps: readonly Step[],
  start: number,
  cells: readonly (Step | null)[],
  patternLength: number,
): Step[] {
  return cells.slice(0, Math.max(0, patternLength - start)).map((c, i) =>
    c ? { ...c } : { ...steps[start + i] },
  );
}

/** Rigid constellation move (USER DECIDED): selected rows shift one row toward
 *  `direction` preserving their gaps; unselected rows inside the affected
 *  window fill the vacated slots preserving their relative order. Window:
 *  up -> [first-1..last], down -> [first..last+1]. Contiguous rows reproduce
 *  the old moveRangeDraft exactly (block + displaced neighbor).
 *  Precondition (caller-enforced clamp): the neighbor row exists in the
 *  buffer; a violated precondition returns [] so nothing dispatches. */
export function moveRowsDraft(
  steps: readonly Step[],
  rows: readonly number[],
  direction: 'up' | 'down',
): Step[] {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (direction === 'up' ? first <= 0 : last >= steps.length - 1) return [];
  const delta = direction === 'up' ? -1 : 1;
  const windowStart = direction === 'up' ? first - 1 : first;
  const size = last - first + 2; // span + the displaced neighbor
  const members = new Set(rows);
  const draft: (Step | undefined)[] = new Array(size);
  for (const r of rows) draft[r + delta - windowStart] = { ...steps[r] };
  const fillers: Step[] = [];
  for (let r = windowStart; r < windowStart + size; r++) {
    if (!members.has(r)) fillers.push({ ...steps[r] });
  }
  let f = 0;
  for (let i = 0; i < size; i++) {
    if (draft[i] === undefined) draft[i] = fillers[f++];
  }
  return draft as Step[];
}
