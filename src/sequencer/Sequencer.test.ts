import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sequencer } from './Sequencer';

describe('Sequencer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with 16 empty steps and default BPM', () => {
    const seq = new Sequencer();
    expect(seq.steps.length).toBe(16);
    expect(seq.bpm).toBe(120);
    expect(seq.isPlaying).toBe(false);
    seq.steps.forEach(step => {
      expect(step.note).toBeNull();
      expect(step.octave).toBe(4);
    });
  });

  it('should start and stop playback, triggering callbacks', () => {
    const seq = new Sequencer();
    const callback = vi.fn();
    const mockCtx = { currentTime: 0 } as AudioContext;
    
    seq.start(mockCtx, callback);
    expect(seq.isPlaying).toBe(true);
    
    // Lookahead loop runs every 25ms
    vi.advanceTimersByTime(25);
    // Should immediately trigger the first note since nextNoteTime (0.1) < currentTime (0) + 0.1 is false?
    // Wait, nextNoteTime is 0.1.
    // while (0.1 < 0 + 0.1) -> false! First note is triggered when currentTime reaches 0.001 or more.
    (mockCtx as any).currentTime = 0.05;
    vi.advanceTimersByTime(25);
    expect(callback).toHaveBeenCalledTimes(1);
    
    // Next note is at 0.1 + 0.125 = 0.225
    (mockCtx as any).currentTime = 0.15;
    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(2);
    
    seq.stop();
    expect(seq.isPlaying).toBe(false);
  });
});
