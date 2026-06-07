import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Outbox } from './Outbox.js';
import type { SetOpClient } from '@fiddle/shared';

interface Harness {
  outbox: Outbox;
  sent: SetOpClient[];
  applied: { path: any; value: any }[];
  live: { current: boolean };
  seq: number;
}

function harness(initiallyLive = true): Harness {
  const live = { current: initiallyLive };
  const sent: SetOpClient[] = [];
  const applied: { path: any; value: any }[] = [];
  let seq = 0;
  const outbox = new Outbox({
    nextClientSeq: () => ++seq,
    send: (op) => sent.push(op),
    applyLocal: (path, value) => applied.push({ path, value }),
    isLive: () => live.current,
  });
  return { outbox, sent, applied, live, seq };
}

describe('Outbox', () => {
  beforeEach(() => vi.useFakeTimers());

  it('throttles consecutive enqueues to one send after 50ms', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.enqueue(['bpm'], 122, 120, false);
    h.outbox.enqueue(['bpm'], 123, 120, false);
    expect(h.sent.length).toBe(0);
    vi.advanceTimersByTime(50);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].value).toBe(123); // last value wins
  });

  it('gestureEnd flushes immediately', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.enqueue(['bpm'], 130, 120, true);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].value).toBe(130);
  });

  it('flushPath sends the pending throttled entry immediately (gesture end)', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.enqueue(['bpm'], 144, 120, false); // still within throttle window
    expect(h.sent.length).toBe(0);
    h.outbox.flushPath(['bpm']);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].value).toBe(144); // latest value, no extra wait
    // The timer was cancelled, so advancing past the window sends nothing more.
    vi.advanceTimersByTime(50);
    expect(h.sent.length).toBe(1);
  });

  it('flushPath is a no-op when nothing is pending for the path', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.flushPath(['tracks', 0, 'mixer', 'volume']); // different path
    expect(h.sent.length).toBe(0);
  });

  it('coalesces by path while offline', () => {
    const h = harness(false);
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.enqueue(['bpm'], 122, 120, false);
    h.outbox.enqueue(['bpm'], 123, 120, false);
    expect(h.sent.length).toBe(0);
    h.live.current = true;
    h.outbox.onLive();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].value).toBe(123);
  });

  it('rolls back on nack', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 999, 120, true);
    expect(h.sent.length).toBe(1);
    const cs = h.sent[0].clientSeq;
    h.outbox.onNack(cs, 'value.invalid');
    expect(h.applied).toEqual([{ path: ['bpm'], value: 120 }]);
  });

  it('onEcho clears in-flight entry (no rollback)', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 140, 120, true);
    const cs = h.sent[0].clientSeq;
    h.outbox.onEcho(cs);
    h.outbox.onNack(cs, 'value.invalid'); // arriving stale; should be ignored
    expect(h.applied).toEqual([]);
  });

  it('different paths do not share throttle window', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 130, 120, false);
    h.outbox.enqueue(['tracks', 0, 'mixer', 'volume'], 0.5, 1.0, false);
    vi.advanceTimersByTime(50);
    expect(h.sent.length).toBe(2);
  });

  it('resends an un-echoed op after the ack timeout, same clientSeq', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 130, 120, true);
    expect(h.sent.length).toBe(1);
    const cs = h.sent[0].clientSeq;
    vi.advanceTimersByTime(4000); // ACK_TIMEOUT_MS
    expect(h.sent.length).toBe(2);
    expect(h.sent[1].clientSeq).toBe(cs); // same seq → server dedupe recognises it
  });

  it('onEcho cancels the resend timer', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 130, 120, true);
    h.outbox.onEcho(h.sent[0].clientSeq!);
    vi.advanceTimersByTime(4000);
    expect(h.sent.length).toBe(1); // no resend
  });

  it('stops resending after the cap', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 130, 120, true);
    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(4000);
    expect(h.sent.length).toBe(1 + 3); // initial + MAX_RESENDS
  });
});
