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

export function clearRangeDraft(start: number, end: number): Step[] {
  return Array.from({ length: end - start + 1 }, () => freshStep());
}

// Rows to write starting at `cursor`, clipped at the pattern window: pasting
// never silently writes into invisible rows past the pattern end (spec).
export function pasteStepsDraft(
  rows: readonly Step[],
  cursor: number,
  patternLength: number,
): Step[] {
  return rows.slice(0, Math.max(0, patternLength - cursor)).map((s) => ({ ...s }));
}

/** Copies of steps[start..end] with `muted` inverted per step (rests included). */
export function toggleMuteRangeDraft(
  steps: readonly Step[],
  start: number,
  end: number,
): Step[] {
  return steps.slice(start, end + 1).map((s) => ({ ...s, muted: !s.muted }));
}

// IDE move-line over the steps buffer: the block [start..end] shifts one row
// toward `direction` and the displaced neighbor row jumps to the block's
// other side. Returns ONLY the affected window:
//   up   -> rows [start-1 .. end]  = [block rows..., old start-1 row]
//   down -> rows [start .. end+1]  = [old end+1 row, block rows...]
// Precondition (caller-enforced clamp): the neighbor row exists in the
// pattern window. A violated precondition returns [] so nothing dispatches.
export function moveRangeDraft(
  steps: readonly Step[],
  start: number,
  end: number,
  direction: 'up' | 'down',
): Step[] {
  const block = steps.slice(start, end + 1).map((s) => ({ ...s }));
  if (direction === 'up') {
    if (start <= 0) return [];
    return [...block, { ...steps[start - 1] }];
  }
  if (end >= steps.length - 1) return [];
  return [{ ...steps[end + 1] }, ...block];
}
