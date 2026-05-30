import { describe, it, expect } from 'vitest';
import { freshTrack, freshStep } from './factory';
import { clearTrack, shiftTrack, fillTrack } from './mutations';

describe('clearTrack', () => {
  it('only clears within the window', () => {
    const t = freshTrack();
    t.patternLength = 4;
    t.steps[2].note = 'C';
    t.steps[10].note = 'E'; // outside window — must be preserved
    clearTrack(t, t.patternLength);
    expect(t.steps[2].note).toBe(null);
    expect(t.steps[10].note).toBe('E');
  });

  it('does not change track.engineType or track.engines', () => {
    const track = freshTrack();
    track.engineType = 'kick';
    track.engines.synth.osc1Coarse = 2;
    clearTrack(track, track.patternLength);
    expect(track.engineType).toBe('kick');
    expect(track.engines.synth.osc1Coarse).toBe(2);
  });
});

describe('shiftTrack', () => {
  it('wraps within the window only (left)', () => {
    const t = freshTrack();
    t.patternLength = 3;
    t.steps[0].note = 'C'; t.steps[1].note = 'D'; t.steps[2].note = 'E';
    t.steps[5].note = 'X'; // outside window — must not move
    shiftTrack(t, 'left', t.patternLength);
    expect([t.steps[0].note, t.steps[1].note, t.steps[2].note]).toEqual(['D', 'E', 'C']);
    expect(t.steps[5].note).toBe('X');
  });

  it('right wraps within the window only', () => {
    const t = freshTrack();
    t.patternLength = 3;
    t.steps[0].note = 'C'; t.steps[1].note = 'D'; t.steps[2].note = 'E';
    shiftTrack(t, 'right', t.patternLength);
    expect([t.steps[0].note, t.steps[1].note, t.steps[2].note]).toEqual(['E', 'C', 'D']);
  });

  it('preserves step length (still 64 after shift)', () => {
    const track = freshTrack();
    shiftTrack(track, 'left', track.patternLength);
    expect(track.steps).toHaveLength(64);
    shiftTrack(track, 'right', track.patternLength);
    expect(track.steps).toHaveLength(64);
  });
});

describe('fillTrack', () => {
  it('only fills within the window', () => {
    const t = freshTrack();
    t.patternLength = 4;
    fillTrack(t, 2, t.patternLength);
    expect(t.steps[0].note).toBe('C');
    expect(t.steps[2].note).toBe('C');
    expect(t.steps[8].note).toBe(null); // outside window untouched
  });

  it('un-mutes filled steps', () => {
    const track = freshTrack();
    track.steps[0].muted = true;
    fillTrack(track, 4, track.patternLength);
    expect(track.steps[0].muted).toBe(false);
  });

  it('resets chord state on filled steps', () => {
    const track = freshTrack();
    track.steps[0].isChord = true;
    track.steps[0].chordType = 'min';
    fillTrack(track, 4, track.patternLength);
    expect(track.steps[0].isChord).toBe(false);
    expect(track.steps[0].chordType).toBe('maj');
  });
});
