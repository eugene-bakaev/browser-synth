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
});
