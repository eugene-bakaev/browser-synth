import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useProjectStore } from './project';
import { useSelectionStore } from './selection';

describe('selection store', () => {
  let project: ReturnType<typeof useProjectStore>;
  let sel: ReturnType<typeof useSelectionStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    project = useProjectStore();
    sel = useSelectionStore();
    project.project.tracks[0].patternLength = 16;
  });

  it('starts empty: validSelection is null', () => {
    expect(sel.validSelection).toBeNull();
  });

  it('place sets a collapsed selection (anchor = head = row)', () => {
    sel.place(0, 5);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 5, last: 5, head: 5, rows: [5] });
    expect(sel.size).toBe(1);
  });

  it('extendTo grows the range from the anchor; upward extension normalizes first/last', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 5, last: 8, head: 8 });
    sel.extendTo(0, 2);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 2, last: 5, head: 2 });
    expect(sel.size).toBe(4);
  });

  it('extendTo on a different track behaves as place', () => {
    project.project.tracks[1].patternLength = 16;
    sel.place(0, 5);
    sel.extendTo(1, 8);
    expect(sel.validSelection).toMatchObject({ trackId: 1, first: 8, last: 8, head: 8 });
  });

  it('moveCursor collapses and moves, clamped to the pattern window', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    sel.moveCursor(1);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 9, last: 9, head: 9 });
    sel.moveCursor(-100);
    expect(sel.validSelection!.head).toBe(0);
    sel.moveCursor(100);
    expect(sel.validSelection!.head).toBe(15);
  });

  it('extendCursor moves only the head, clamped', () => {
    sel.place(0, 5);
    sel.extendCursor(2);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 5, last: 7, head: 7 });
    sel.extendCursor(-100);
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 0, last: 5, head: 0 });
  });

  it('moveCursor/extendCursor are no-ops without a valid selection', () => {
    sel.moveCursor(1);
    sel.extendCursor(1);
    expect(sel.validSelection).toBeNull();
  });

  it('isSelected answers per-track per-row', () => {
    sel.place(0, 3);
    sel.extendTo(0, 5);
    expect(sel.isSelected(0, 4)).toBe(true);
    expect(sel.isSelected(0, 6)).toBe(false);
    expect(sel.isSelected(1, 4)).toBe(false);
  });

  it('validSelection clamps a range that pattern-shrink left partially outside', () => {
    sel.place(0, 10);
    sel.extendTo(0, 14);
    project.project.tracks[0].patternLength = 12;
    expect(sel.validSelection).toMatchObject({ trackId: 0, first: 10, last: 11, head: 11 });
  });

  it('validSelection is null when the range is fully outside the window', () => {
    sel.place(0, 10);
    project.project.tracks[0].patternLength = 8;
    expect(sel.validSelection).toBeNull();
  });

  it('validSelection is null for a disabled track and clear() empties', () => {
    sel.place(0, 3);
    project.project.tracks[0].enabled = false;
    expect(sel.validSelection).toBeNull();
    project.project.tracks[0].enabled = true;
    sel.clear();
    expect(sel.trackId).toBeNull();
    expect(sel.validSelection).toBeNull();
  });

  // ---- multi-select (cmd+click) ----

  it('toggleRow with no selection (or another track) behaves as place', () => {
    sel.toggleRow(0, 4);
    expect(sel.validSelection).toMatchObject({ trackId: 0, rows: [4], head: 4 });
    project.project.tracks[1].patternLength = 16;
    sel.toggleRow(1, 7); // different track → fresh selection there
    expect(sel.validSelection).toMatchObject({ trackId: 1, rows: [7], head: 7 });
  });

  it('toggleRow on an unselected row freezes the active segment and collapses there', () => {
    sel.place(0, 2);
    sel.extendTo(0, 4); // active 2..4
    sel.toggleRow(0, 8);
    expect(sel.validSelection).toMatchObject({ trackId: 0, rows: [2, 3, 4, 8], first: 2, last: 8, head: 8 });
    expect(sel.validSelection!.ranges).toEqual([{ start: 2, end: 4 }, { start: 8, end: 8 }]);
  });

  it('shift-extend after toggleRow reshapes only the active segment; frozen rows persist', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 8);
    sel.extendTo(0, 11); // active 8..11
    expect(sel.validSelection!.rows).toEqual([2, 8, 9, 10, 11]);
    sel.extendTo(0, 9); // shrink active to 8..9 — 10,11 drop, 2 survives
    expect(sel.validSelection!.rows).toEqual([2, 8, 9]);
    sel.extendCursor(1); // keyboard shift+down: active 8..10
    expect(sel.validSelection!.rows).toEqual([2, 8, 9, 10]);
  });

  it('toggleRow off keeps the cursor at the old head when the head survives', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 5);
    sel.toggleRow(0, 8); // rows 2,5,8; head 8
    sel.toggleRow(0, 5); // remove a non-head row
    expect(sel.validSelection).toMatchObject({ rows: [2, 8], head: 8 });
  });

  it('toggleRow off the head moves the cursor to the nearest remaining row (tie → lower)', () => {
    sel.place(0, 4);
    sel.toggleRow(0, 6); // rows 4,6; head 6
    sel.toggleRow(0, 6); // remove the head; nearest remaining is 4
    expect(sel.validSelection).toMatchObject({ rows: [4], head: 4 });
    sel.toggleRow(0, 2); // rows 2,4
    sel.toggleRow(0, 8); // rows 2,4,8; head 8
    sel.toggleRow(0, 8); // equidistant would need a mid row — nearest to 8 is 4
    expect(sel.validSelection).toMatchObject({ rows: [2, 4], head: 4 });
    sel.toggleRow(0, 3); // rows 2,3,4; head 3
    sel.toggleRow(0, 3); // 2 and 4 equidistant from 3 → tie goes to the lower (2)
    expect(sel.validSelection).toMatchObject({ rows: [2, 4], head: 2 });
  });

  it('toggling off the only selected row clears the selection', () => {
    sel.toggleRow(0, 4);
    sel.toggleRow(0, 4);
    expect(sel.validSelection).toBeNull();
    expect(sel.trackId).toBeNull();
  });

  it('rows and ranges are sorted/deduped when frozen overlaps the active segment', () => {
    sel.place(0, 5);
    sel.toggleRow(0, 3); // frozen {5}, active 3
    sel.extendTo(0, 6);  // active 3..6 overlaps frozen 5
    expect(sel.validSelection!.rows).toEqual([3, 4, 5, 6]);
    expect(sel.validSelection!.ranges).toEqual([{ start: 3, end: 6 }]);
  });

  it('place and moveCursor reset frozen rows; a plain gesture collapses the multi-selection', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 8);
    sel.place(0, 5);
    expect(sel.validSelection!.rows).toEqual([5]);
    sel.toggleRow(0, 9);
    sel.moveCursor(1);
    expect(sel.validSelection!.rows).toEqual([10]);
  });

  it('pattern shrink filters frozen rows from the read without mutating state', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 14); // frozen {2}, active 14
    project.project.tracks[0].patternLength = 12;
    expect(sel.validSelection).toMatchObject({ rows: [2], head: 11 });
    project.project.tracks[0].patternLength = 16;
    expect(sel.validSelection!.rows).toEqual([2, 14]); // 14 was never deleted
  });

  it('shiftAll shifts frozen rows, anchor, and head together', () => {
    sel.place(0, 2);
    sel.toggleRow(0, 5);
    sel.extendTo(0, 6); // rows 2,5,6; head 6
    sel.shiftAll(1);
    expect(sel.validSelection).toMatchObject({ rows: [3, 6, 7], head: 7 });
    sel.shiftAll(-1);
    expect(sel.validSelection).toMatchObject({ rows: [2, 5, 6], head: 6 });
  });

  it('selectRows selects exactly the given rows with the head on the last', () => {
    sel.selectRows(0, [3, 7, 9]);
    expect(sel.validSelection).toMatchObject({ trackId: 0, rows: [3, 7, 9], head: 9 });
    expect(sel.validSelection!.ranges).toEqual([{ start: 3, end: 3 }, { start: 7, end: 7 }, { start: 9, end: 9 }]);
    sel.selectRows(0, []); // no-op
    expect(sel.validSelection!.rows).toEqual([3, 7, 9]);
  });
});
