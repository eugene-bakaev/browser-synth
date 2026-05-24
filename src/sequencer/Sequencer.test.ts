import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sequencer } from './Sequencer';

describe('Sequencer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with isPlaying false', () => {
    const seq = new Sequencer();
    expect(seq.isPlaying).toBe(false);
  });

  it('should start and stop playback, triggering callbacks with step indices', () => {
    const seq = new Sequencer();
    const onStep = vi.fn();
    const mockCtx = { currentTime: 0 } as AudioContext;
    let bpm = 120;

    seq.start(mockCtx, () => bpm, onStep);
    expect(seq.isPlaying).toBe(true);

    // Lookahead loop runs every 25ms
    vi.advanceTimersByTime(25);
    (mockCtx as any).currentTime = 0.05;
    vi.advanceTimersByTime(25);
    // Should trigger callback with step index 0
    expect(onStep).toHaveBeenCalledWith(0, 0.1);
    expect(onStep).toHaveBeenCalledTimes(1);

    // Next note is at 0.1 + 0.125 = 0.225
    (mockCtx as any).currentTime = 0.15;
    vi.advanceTimersByTime(125);
    // Should trigger callback with step index 1
    expect(onStep).toHaveBeenCalledWith(1, 0.225);
    expect(onStep).toHaveBeenCalledTimes(2);

    seq.stop();
    expect(seq.isPlaying).toBe(false);
  });

  it('should rebase the schedule anchor on BPM change mid-playback', () => {
    const seq = new Sequencer();
    const onStep = vi.fn();
    const mockCtx = { currentTime: 0 } as AudioContext;
    let bpm = 120;

    seq.start(mockCtx, () => bpm, onStep);

    // Schedule the first step at t=0.1 (BPM 120, stepTime=0.125)
    (mockCtx as any).currentTime = 0.05;
    vi.advanceTimersByTime(25);
    expect(onStep).toHaveBeenLastCalledWith(0, 0.1);

    // Schedule step 1 at t=0.225
    (mockCtx as any).currentTime = 0.15;
    vi.advanceTimersByTime(125);
    expect(onStep).toHaveBeenLastCalledWith(1, 0.225);

    // Now drop tempo to 60 BPM (stepTime=0.25). Next step should be 0.225 + 0.25 = 0.475,
    // anchored to the existing position rather than snapping to a stale grid.
    bpm = 60;
    (mockCtx as any).currentTime = 0.4;
    vi.advanceTimersByTime(25);
    expect(onStep).toHaveBeenLastCalledWith(2, 0.475);

    seq.stop();
  });
});
