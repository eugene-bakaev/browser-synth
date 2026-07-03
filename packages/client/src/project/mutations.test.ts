import { describe, it, expect } from 'vitest';
import { freshTrack } from './factory';
import { clearTrackDraft, shiftTrackDraft, fillTrackDraft } from './mutations';

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
