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
    
    seq.start(callback);
    expect(seq.isPlaying).toBe(true);
    
    // BPM 120 -> 500ms per beat -> 125ms per 16th note
    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(1);
    
    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(2);
    
    seq.stop();
    expect(seq.isPlaying).toBe(false);
    
    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(2); // Should not increase
  });
});
