import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoadTracker } from './LoadTracker';
import type { LoadMessage } from '@fiddle/shared';

const msg = (clientSeq: number): LoadMessage =>
  ({ v: 1, type: 'load', clientSeq, project: {} });
const prior = { bpm: 111 } as any;

describe('LoadTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = () => {
    const deps = {
      send: vi.fn(),
      rollback: vi.fn(),
      onError: vi.fn(),
      ackTimeoutMs: 5000,
    };
    return { deps, tracker: new LoadTracker(deps) };
  };

  it('snapshot arrival clears the pending load', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    expect(tracker.hasPending).toBe(true);
    tracker.onSnapshot();
    expect(tracker.hasPending).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
  });

  it('matching nack rolls back to prior and reports the error', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    expect(tracker.onNack(1, 'value.invalid', 'bad project')).toBe(true);
    expect(deps.rollback).toHaveBeenCalledWith(prior);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(tracker.hasPending).toBe(false);
  });

  it('non-matching nack is ignored (returns false, no rollback)', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    expect(tracker.onNack(9, 'value.invalid', 'other op')).toBe(false);
    expect(deps.rollback).not.toHaveBeenCalled();
    expect(tracker.hasPending).toBe(true);
  });

  it('ack timeout resends once, then rolls back and errors', () => {
    const { deps, tracker } = make();
    const m = msg(1);
    tracker.begin(m, prior);
    vi.advanceTimersByTime(5000);
    expect(deps.send).toHaveBeenCalledExactlyOnceWith(m);
    expect(tracker.hasPending).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(deps.rollback).toHaveBeenCalledWith(prior);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(tracker.hasPending).toBe(false);
  });

  it('socket close drops the pending load without rollback (snapshot-on-resume settles it)', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    tracker.onClosed();
    expect(tracker.hasPending).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
  });
});
