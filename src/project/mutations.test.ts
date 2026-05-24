import { describe, it, expect } from 'vitest';
import { freshTrack, freshStep } from './factory';
import { clearTrack, shiftTrack, fillTrack } from './mutations';

describe('clearTrack', () => {
  it('resets every step to freshStep defaults', () => {
    const track = freshTrack();
    track.steps[0].note = 'C';
    track.steps[0].velocity = 0.3;
    track.steps[5].muted = true;
    track.steps[10].isChord = true;
    clearTrack(track);
    for (const s of track.steps) {
      expect(s).toEqual(freshStep());
    }
  });

  it('does not change track.engineType or track.engines', () => {
    const track = freshTrack();
    track.engineType = 'kick';
    track.engines.synth.osc1Coarse = 2;
    clearTrack(track);
    expect(track.engineType).toBe('kick');
    expect(track.engines.synth.osc1Coarse).toBe(2);
  });
});

describe('shiftTrack', () => {
  it('shifts left: first → last', () => {
    const track = freshTrack();
    track.steps[0].note = 'A';
    track.steps[1].note = 'B';
    shiftTrack(track, 'left');
    expect(track.steps[0].note).toBe('B');
    expect(track.steps[15].note).toBe('A');
  });

  it('shifts right: last → first', () => {
    const track = freshTrack();
    track.steps[15].note = 'Z';
    shiftTrack(track, 'right');
    expect(track.steps[0].note).toBe('Z');
    expect(track.steps[15].note).toBeNull();
  });

  it('preserves step length (still 16 after shift)', () => {
    const track = freshTrack();
    shiftTrack(track, 'left');
    expect(track.steps).toHaveLength(16);
    shiftTrack(track, 'right');
    expect(track.steps).toHaveLength(16);
  });
});

describe('fillTrack', () => {
  it('sets note="C" on every Nth step (interval 4 → indices 0,4,8,12)', () => {
    const track = freshTrack();
    fillTrack(track, 4);
    [0, 4, 8, 12].forEach(i => expect(track.steps[i].note).toBe('C'));
    [1, 2, 3, 5, 6, 7].forEach(i => expect(track.steps[i].note).toBeNull());
  });

  it('un-mutes filled steps', () => {
    const track = freshTrack();
    track.steps[0].muted = true;
    fillTrack(track, 4);
    expect(track.steps[0].muted).toBe(false);
  });

  it('resets chord state on filled steps', () => {
    const track = freshTrack();
    track.steps[0].isChord = true;
    track.steps[0].chordType = 'min';
    fillTrack(track, 4);
    expect(track.steps[0].isChord).toBe(false);
    expect(track.steps[0].chordType).toBe('maj');
  });
});
