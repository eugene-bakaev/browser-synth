import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sequencer } from './Sequencer';

describe('Sequencer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with 4 tracks, each having 16 empty steps and default BPM', () => {
    const seq = new Sequencer();
    expect(seq.tracks.length).toBe(4);
    expect(seq.bpm).toBe(120);
    expect(seq.isPlaying).toBe(false);
    seq.tracks.forEach((track, index) => {
      expect(track.id).toBe(index);
      expect(track.name).toBe(`Track ${index + 1}`);
      expect(track.steps.length).toBe(16);
      track.steps.forEach(step => {
        expect(step.note).toBeNull();
        expect(step.octave).toBe(4);
        expect(step.isChord).toBe(false);
        expect(step.chordType).toBe('maj');
      });
    });
  });

  it('should start and stop playback, triggering callbacks with step indices', () => {
    const seq = new Sequencer();
    const callback = vi.fn();
    const mockCtx = { currentTime: 0 } as AudioContext;
    
    seq.start(mockCtx, callback);
    expect(seq.isPlaying).toBe(true);
    
    // Lookahead loop runs every 25ms
    vi.advanceTimersByTime(25);
    (mockCtx as any).currentTime = 0.05;
    vi.advanceTimersByTime(25);
    // Should trigger callback with step index 0
    expect(callback).toHaveBeenCalledWith(0, 0.1);
    expect(callback).toHaveBeenCalledTimes(1);
    
    // Next note is at 0.1 + 0.125 = 0.225
    (mockCtx as any).currentTime = 0.15;
    vi.advanceTimersByTime(125);
    // Should trigger callback with step index 1
    expect(callback).toHaveBeenCalledWith(1, 0.225);
    expect(callback).toHaveBeenCalledTimes(2);
    
    seq.stop();
    expect(seq.isPlaying).toBe(false);
  });

  describe('Utility operations', () => {
    it('should clear all steps of a track', () => {
      const seq = new Sequencer();
      seq.tracks[0].steps[2].note = 'C';
      seq.tracks[0].steps[2].muted = true;
      seq.tracks[0].steps[2].velocity = 0.35;
      seq.tracks[0].steps[2].octave = 2;
      seq.tracks[0].steps[2].length = 4;
      seq.tracks[0].steps[2].isChord = true;
      seq.tracks[0].steps[2].chordType = 'min';

      seq.clearTrack(0);

      const step = seq.tracks[0].steps[2];
      expect(step.note).toBeNull();
      expect(step.muted).toBe(false);
      expect(step.velocity).toBe(0.8);
      expect(step.octave).toBe(4);
      expect(step.length).toBe(1);
      expect(step.isChord).toBe(false);
      expect(step.chordType).toBe('maj');
    });

    it('should shift steps circularly left and right', () => {
      const seq = new Sequencer();
      // Set values at index 0, 1, 2
      seq.tracks[0].steps[0].note = 'C';
      seq.tracks[0].steps[1].note = 'D';
      seq.tracks[0].steps[15].note = 'B';

      // Shift right
      seq.shiftTrack(0, 'right');
      expect(seq.tracks[0].steps[0].note).toBe('B');
      expect(seq.tracks[0].steps[1].note).toBe('C');
      expect(seq.tracks[0].steps[2].note).toBe('D');
      expect(seq.tracks[0].steps[15].note).toBeNull();

      // Shift left (back to original)
      seq.shiftTrack(0, 'left');
      expect(seq.tracks[0].steps[0].note).toBe('C');
      expect(seq.tracks[0].steps[1].note).toBe('D');
      expect(seq.tracks[0].steps[15].note).toBe('B');
    });

    it('should fill steps at specific intervals', () => {
      const seq = new Sequencer();
      seq.fillTrack(0, 4);

      seq.tracks[0].steps.forEach((step, index) => {
        if (index % 4 === 0) {
          expect(step.note).toBe('C');
          expect(step.velocity).toBe(0.8);
          expect(step.muted).toBe(false);
        } else {
          expect(step.note).toBeNull();
        }
      });
    });
  });
});

