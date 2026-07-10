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
    expect(sel.validSelection).toEqual({ trackId: 0, start: 5, end: 5, head: 5 });
    expect(sel.size).toBe(1);
  });

  it('extendTo grows the range from the anchor; upward extension normalizes start/end', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 5, end: 8, head: 8 });
    sel.extendTo(0, 2);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 2, end: 5, head: 2 });
    expect(sel.size).toBe(4);
  });

  it('extendTo on a different track behaves as place', () => {
    project.project.tracks[1].patternLength = 16;
    sel.place(0, 5);
    sel.extendTo(1, 8);
    expect(sel.validSelection).toEqual({ trackId: 1, start: 8, end: 8, head: 8 });
  });

  it('moveCursor collapses and moves, clamped to the pattern window', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    sel.moveCursor(1);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 9, end: 9, head: 9 });
    sel.moveCursor(-100);
    expect(sel.validSelection!.head).toBe(0);
    sel.moveCursor(100);
    expect(sel.validSelection!.head).toBe(15);
  });

  it('extendCursor moves only the head, clamped', () => {
    sel.place(0, 5);
    sel.extendCursor(2);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 5, end: 7, head: 7 });
    sel.extendCursor(-100);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 0, end: 5, head: 0 });
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
    expect(sel.validSelection).toEqual({ trackId: 0, start: 10, end: 11, head: 11 });
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
});
