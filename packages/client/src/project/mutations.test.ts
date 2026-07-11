import { describe, it, expect } from 'vitest';
import { freshTrack, freshStep } from './factory';
import type { Step } from '@fiddle/shared';
import { clearTrackDraft, shiftTrackDraft, fillTrackDraft, clearRangeDraft, pasteStepsDraft, toggleMuteRangeDraft, moveRangeDraft, toggleMuteRowsDraft, clearRowsDraft, pasteCellsDraft, moveRowsDraft } from './mutations';

describe('clearTrackDraft', () => {
  it('returns a fresh window of exactly patternLength steps', () => {
    const draft = clearTrackDraft(4);
    expect(draft).toHaveLength(4);
    expect(draft.every((s) => s.note === null)).toBe(true);
  });

  it('does not touch any track state (pure)', () => {
    const track = freshTrack();
    track.engineType = 'kick';
    track.engines.synth.osc1Coarse = 2;
    clearTrackDraft(track.patternLength);
    expect(track.engineType).toBe('kick');
    expect(track.engines.synth.osc1Coarse).toBe(2);
  });
});

describe('shiftTrackDraft', () => {
  it('wraps within the window only (left)', () => {
    const t = freshTrack();
    t.patternLength = 3;
    t.steps[0].note = 'C'; t.steps[1].note = 'D'; t.steps[2].note = 'E';
    t.steps[5].note = 'X'; // outside window — must not appear in the draft
    const draft = shiftTrackDraft(t.steps, 'left', t.patternLength);
    expect(draft.map((s) => s.note)).toEqual(['D', 'E', 'C']);
  });

  it('right wraps within the window only', () => {
    const t = freshTrack();
    t.patternLength = 3;
    t.steps[0].note = 'C'; t.steps[1].note = 'D'; t.steps[2].note = 'E';
    const draft = shiftTrackDraft(t.steps, 'right', t.patternLength);
    expect(draft.map((s) => s.note)).toEqual(['E', 'C', 'D']);
  });

  it('returns exactly patternLength steps', () => {
    const track = freshTrack();
    expect(shiftTrackDraft(track.steps, 'left', track.patternLength)).toHaveLength(track.patternLength);
    expect(shiftTrackDraft(track.steps, 'right', track.patternLength)).toHaveLength(track.patternLength);
  });

  it('patternLength <= 1 returns the window unchanged', () => {
    const track = freshTrack();
    track.patternLength = 1;
    track.steps[0].note = 'G';
    const draft = shiftTrackDraft(track.steps, 'left', track.patternLength);
    expect(draft).toEqual([expect.objectContaining({ note: 'G' })]);
  });
});

describe('fillTrackDraft', () => {
  it('only fills within the window', () => {
    const t = freshTrack();
    t.patternLength = 4;
    const draft = fillTrackDraft(t.steps, 2, t.patternLength);
    expect(draft[0].note).toBe('C');
    expect(draft[2].note).toBe('C');
    expect(draft).toHaveLength(4); // outside-window steps are not part of the draft at all
  });

  it('un-mutes filled steps', () => {
    const track = freshTrack();
    track.steps[0].muted = true;
    const draft = fillTrackDraft(track.steps, 4, track.patternLength);
    expect(draft[0].muted).toBe(false);
  });

  it('resets chord state on filled steps', () => {
    const track = freshTrack();
    track.steps[0].isChord = true;
    track.steps[0].chordType = 'min';
    const draft = fillTrackDraft(track.steps, 4, track.patternLength);
    expect(draft[0].isChord).toBe(false);
    expect(draft[0].chordType).toBe('maj');
  });

  it('interval <= 0 returns the window unchanged (modulo guard)', () => {
    const track = freshTrack();
    track.patternLength = 4;
    const draft = fillTrackDraft(track.steps, 0, track.patternLength);
    expect(draft.every((s) => s.note === null)).toBe(true);
  });
});

describe('clearRangeDraft', () => {
  it('produces factory-default steps, one per row in [start, end]', () => {
    const draft = clearRangeDraft(3, 6);
    expect(draft).toHaveLength(4);
    for (const s of draft) expect(s).toEqual(freshStep());
  });
});

describe('pasteStepsDraft', () => {
  const rows: Step[] = [
    { ...freshStep(), note: 'C' },
    { ...freshStep(), note: 'D' },
    { ...freshStep(), note: 'E' },
  ];
  it('returns copies of all rows when they fit', () => {
    const draft = pasteStepsDraft(rows, 2, 16);
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', 'E']);
    expect(draft[0]).not.toBe(rows[0]); // copy, not reference
  });
  it('clips at the pattern window', () => {
    expect(pasteStepsDraft(rows, 14, 16).map((s) => s.note)).toEqual(['C', 'D']);
    expect(pasteStepsDraft(rows, 15, 16)).toHaveLength(1);
  });
  it('returns [] when the cursor is at/past the window edge', () => {
    expect(pasteStepsDraft(rows, 16, 16)).toEqual([]);
  });
});

describe('toggleMuteRangeDraft', () => {
  it('flips each step independently (mixed stays mixed, inverted)', () => {
    const t = freshTrack();
    t.steps[2].muted = true; t.steps[2].note = 'C';
    t.steps[3].muted = false; t.steps[3].note = 'D';
    const draft = toggleMuteRangeDraft(t.steps, 2, 4);
    expect(draft.map((s) => s.muted)).toEqual([false, true, true]);
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', null]); // other fields untouched
  });

  it('includes rests, returns copies, and never mutates the input', () => {
    const t = freshTrack();
    const draft = toggleMuteRangeDraft(t.steps, 0, 0);
    expect(draft[0].muted).toBe(true); // rest flipped too
    expect(draft[0]).not.toBe(t.steps[0]);
    expect(t.steps[0].muted).toBe(false);
  });
});

describe('moveRangeDraft', () => {
  // Distinct note markers: row1='A' row2='C' row3='D' row4='E' row5='F'
  function marked(): Step[] {
    const t = freshTrack();
    t.steps[1].note = 'A'; t.steps[2].note = 'C'; t.steps[3].note = 'D';
    t.steps[4].note = 'E'; t.steps[5].note = 'F';
    return t.steps;
  }

  it('up: returns rows [start-1..end] = block first, displaced row last', () => {
    // Moving [2..4] up -> rows 1..4 become [old2, old3, old4, old1]
    const draft = moveRangeDraft(marked(), 2, 4, 'up');
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', 'E', 'A']);
  });

  it('down: returns rows [start..end+1] = displaced row first, block after', () => {
    // Moving [2..4] down -> rows 2..5 become [old5, old2, old3, old4]
    const draft = moveRangeDraft(marked(), 2, 4, 'down');
    expect(draft.map((s) => s.note)).toEqual(['F', 'C', 'D', 'E']);
  });

  it('single-row block moves both directions', () => {
    expect(moveRangeDraft(marked(), 2, 2, 'up').map((s) => s.note)).toEqual(['C', 'A']);
    expect(moveRangeDraft(marked(), 2, 2, 'down').map((s) => s.note)).toEqual(['D', 'C']);
  });

  it('returns copies, never references into the input array', () => {
    const steps = marked();
    for (const row of moveRangeDraft(steps, 2, 4, 'up')) {
      expect(steps.includes(row as Step)).toBe(false);
    }
  });

  it('defensive: missing neighbor returns [] (up at row 0, down at the buffer end)', () => {
    const steps = marked();
    expect(moveRangeDraft(steps, 0, 2, 'up')).toEqual([]);
    expect(moveRangeDraft(steps, 62, 63, 'down')).toEqual([]);
  });
});

describe('toggleMuteRowsDraft', () => {
  it('contiguous rows reproduce toggleMuteRangeDraft exactly (regression oracle vs 610603c)', () => {
    const t = freshTrack();
    t.steps[2].muted = true; t.steps[2].note = 'C';
    t.steps[3].muted = false; t.steps[3].note = 'D';
    const draft = toggleMuteRowsDraft(t.steps, [2, 3, 4]);
    expect(draft.map((s) => s.muted)).toEqual([false, true, true]);
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', null]);
  });

  it('gapped rows: members flip, gap rows are copied through unchanged', () => {
    const t = freshTrack();
    t.steps[3].muted = true; t.steps[3].note = 'G';
    const draft = toggleMuteRowsDraft(t.steps, [2, 5]);
    expect(draft).toHaveLength(4); // span [2..5]
    expect(draft.map((s) => s.muted)).toEqual([true, true, false, true]);
    expect(draft[1].note).toBe('G'); // gap row content intact
  });

  it('returns copies and never mutates the input', () => {
    const t = freshTrack();
    const draft = toggleMuteRowsDraft(t.steps, [0, 2]);
    expect(draft[0]).not.toBe(t.steps[0]);
    expect(draft[1]).not.toBe(t.steps[1]);
    expect(t.steps[0].muted).toBe(false);
    expect(t.steps[1].muted).toBe(false);
  });
});

describe('clearRowsDraft', () => {
  it('members become factory-default steps; gap rows copy through', () => {
    const t = freshTrack();
    t.steps[2].note = 'C'; t.steps[3].note = 'D'; t.steps[4].note = 'E';
    const draft = clearRowsDraft(t.steps, [2, 4]);
    expect(draft).toHaveLength(3);
    expect(draft[0]).toEqual(freshStep());
    expect(draft[1].note).toBe('D'); // gap untouched
    expect(draft[2]).toEqual(freshStep());
  });

  it('contiguous rows produce a fresh step per row (clearRangeDraft oracle)', () => {
    const t = freshTrack();
    const draft = clearRowsDraft(t.steps, [3, 4, 5, 6]);
    expect(draft).toHaveLength(4);
    for (const s of draft) expect(s).toEqual(freshStep());
  });

  it('never mutates the input', () => {
    const t = freshTrack();
    t.steps[2].note = 'C';
    clearRowsDraft(t.steps, [2]);
    expect(t.steps[2].note).toBe('C');
  });
});

describe('pasteCellsDraft', () => {
  function dest(): Step[] {
    const t = freshTrack();
    t.steps[9].note = 'G'; t.steps[10].note = 'A'; t.steps[11].note = 'B';
    return t.steps;
  }
  const cells: (Step | null)[] = [
    { ...freshStep(), note: 'C' },
    null,
    { ...freshStep(), note: 'E' },
  ];

  it('non-null cells overwrite; null holes copy the destination row through', () => {
    const draft = pasteCellsDraft(dest(), 9, cells, 16);
    expect(draft.map((s) => s.note)).toEqual(['C', 'A', 'E']);
  });

  it('clips at the pattern window, not the steps buffer', () => {
    const draft = pasteCellsDraft(dest(), 14, cells, 16);
    expect(draft).toHaveLength(2); // rows 14,15 only — buffer has 64 slots
    expect(pasteCellsDraft(dest(), 16, cells, 16)).toEqual([]);
  });

  it('returns copies, not references (cells and destination alike)', () => {
    const steps = dest();
    const draft = pasteCellsDraft(steps, 9, cells, 16);
    expect(draft[0]).not.toBe(cells[0]);
    expect(draft[1]).not.toBe(steps[10]);
  });
});

describe('moveRowsDraft', () => {
  // Distinct note markers on rows 1..7.
  function marked(): Step[] {
    const t = freshTrack();
    const notes = ['A', 'C', 'D', 'E', 'F', 'G', 'B'];
    notes.forEach((n, i) => { t.steps[i + 1].note = n; });
    return t.steps;
  }

  it('contiguous up reproduces moveRangeDraft exactly (610603c oracle)', () => {
    expect(moveRowsDraft(marked(), [2, 3, 4], 'up').map((s) => s.note))
      .toEqual(['C', 'D', 'E', 'A']); // rows 1..4 = block first, displaced last
  });

  it('contiguous down reproduces moveRangeDraft exactly (610603c oracle)', () => {
    expect(moveRowsDraft(marked(), [2, 3, 4], 'down').map((s) => s.note))
      .toEqual(['F', 'C', 'D', 'E']); // rows 2..5 = displaced first, block after
  });

  it('gapped down: constellation shifts rigidly, unselected fill vacated slots in order', () => {
    // rows 2,5,6 of [1:A 2:C 3:D 4:E 5:F 6:G 7:B]; window [2..7].
    // Selected land on 3,6,7; unselected old 3,4,7 fill slots 2,4,5 in order.
    expect(moveRowsDraft(marked(), [2, 5, 6], 'down').map((s) => s.note))
      .toEqual(['D', 'C', 'E', 'B', 'F', 'G']); // rows 2..7
  });

  it('gapped up: mirror of the worked example', () => {
    // rows 2,5,6 up; window [1..6]. Selected land on 1,4,5;
    // unselected old 1,3,4 fill slots 2,3,6 in order.
    expect(moveRowsDraft(marked(), [2, 5, 6], 'up').map((s) => s.note))
      .toEqual(['C', 'A', 'D', 'F', 'G', 'E']); // rows 1..6
  });

  it('single gapped pair moves both directions', () => {
    // rows 2,4 down: window [2..5], selected land 3,5; unselected old 3,5 → slots 2,4.
    expect(moveRowsDraft(marked(), [2, 4], 'down').map((s) => s.note))
      .toEqual(['D', 'C', 'F', 'E']);
    // rows 2,4 up: window [1..4], selected land 1,3; unselected old 1,3 → slots 2,4.
    expect(moveRowsDraft(marked(), [2, 4], 'up').map((s) => s.note))
      .toEqual(['C', 'A', 'E', 'D']);
  });

  it('returns copies, never references into the input array', () => {
    const steps = marked();
    for (const row of moveRowsDraft(steps, [2, 5], 'down')) {
      expect(steps.includes(row as Step)).toBe(false);
    }
  });

  it('defensive: missing neighbor returns [] (up at row 0, down at the buffer end)', () => {
    const steps = marked();
    expect(moveRowsDraft(steps, [0, 2], 'up')).toEqual([]);
    expect(moveRowsDraft(steps, [60, 63], 'down')).toEqual([]);
  });
});
