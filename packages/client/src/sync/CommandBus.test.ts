import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Path, SetOpBroadcast } from '@fiddle/shared';
import { createCommandBus } from './CommandBus';

// Fakes: record what the bus would do to the store and the outbox.
function makeFakes() {
  const writes: Array<{ path: Path; value: unknown }> = [];
  const enqueues: Array<{ path: Path; value: unknown; priorValue: unknown; gestureEnd: boolean }> = [];
  return {
    writes,
    enqueues,
    deps: {
      applySet: (path: Path, value: unknown) => { writes.push({ path, value }); },
      loadProject: () => {},
      enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) =>
        { enqueues.push({ path, value, priorValue, gestureEnd }); },
    },
  };
}

function broadcast(path: Path, value: unknown, opId: number): SetOpBroadcast {
  // Minimal shape the bus reads: path/value/opId. Cast covers the wire-only
  // fields (clientId/clientSeq/etc.) the bus never touches.
  return { type: 'set', path, value, opId } as unknown as SetOpBroadcast;
}

describe('CommandBus', () => {
  let f: ReturnType<typeof makeFakes>;
  beforeEach(() => { f = makeFakes(); });

  it('dispatchLocal writes state AND enqueues (gestureEnd defaults false)', () => {
    const bus = createCommandBus(f.deps);
    bus.dispatchLocal({ path: ['bpm'], value: 128, priorValue: 120 });
    expect(f.writes).toEqual([{ path: ['bpm'], value: 128 }]);
    expect(f.enqueues).toEqual([{ path: ['bpm'], value: 128, priorValue: 120, gestureEnd: false }]);
  });

  it('dispatchLocal forwards gestureEnd when set', () => {
    const bus = createCommandBus(f.deps);
    bus.dispatchLocal({ path: ['tracks', 0, 'engineType'], value: 'kick2', priorValue: 'synth', gestureEnd: true });
    expect(f.enqueues[0].gestureEnd).toBe(true);
  });

  it('applyRemote writes state and does NOT enqueue', () => {
    const bus = createCommandBus(f.deps);
    const wrote = bus.applyRemote(broadcast(['bpm'], 90, 1));
    expect(wrote).toBe(true);
    expect(f.writes).toEqual([{ path: ['bpm'], value: 90 }]);
    expect(f.enqueues).toEqual([]); // remote never echoes back out
  });

  it('applyRemote drops a stale opId for the same path (watermark) and does not write', () => {
    const bus = createCommandBus(f.deps);
    expect(bus.applyRemote(broadcast(['bpm'], 90, 5))).toBe(true);
    expect(bus.applyRemote(broadcast(['bpm'], 80, 3))).toBe(false); // older opId
    expect(bus.applyRemote(broadcast(['bpm'], 80, 5))).toBe(false); // equal opId
    expect(f.writes).toEqual([{ path: ['bpm'], value: 90 }]); // only the first wrote
  });

  it('applyRemote tracks the watermark per path independently', () => {
    const bus = createCommandBus(f.deps);
    expect(bus.applyRemote(broadcast(['tracks', 0, 'engineType'], 'kick', 9))).toBe(true);
    // a fresh path starts below any opId, so a low opId still applies
    expect(bus.applyRemote(broadcast(['tracks', 1, 'engineType'], 'hat', 2))).toBe(true);
    expect(f.writes).toHaveLength(2);
  });

  it('resetWatermark lets a previously-stale opId apply again (reconnect/snapshot)', () => {
    const bus = createCommandBus(f.deps);
    bus.applyRemote(broadcast(['bpm'], 90, 5));
    bus.resetWatermark();
    expect(bus.applyRemote(broadcast(['bpm'], 80, 1))).toBe(true);
    expect(f.writes).toEqual([{ path: ['bpm'], value: 90 }, { path: ['bpm'], value: 80 }]);
  });

  it('applyRemote returns false and does not throw when applySet throws (bad path)', () => {
    const writes: Path[] = [];
    const bus = createCommandBus({
      applySet: () => { throw new Error('unresolvable path'); },
      loadProject: () => {},
      enqueue: (path: Path) => { writes.push(path); },
    });
    expect(bus.applyRemote(broadcast(['tracks', 999, 'nope'], 1, 1))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('advanceWatermark advances without writing and rejects stale opIds', () => {
    const bus = createCommandBus(f.deps);
    expect(bus.advanceWatermark(['bpm'], 5)).toBe(true);
    expect(bus.advanceWatermark(['bpm'], 3)).toBe(false); // older
    expect(bus.advanceWatermark(['bpm'], 5)).toBe(false); // equal
    expect(f.writes).toEqual([]); // never writes
    expect(f.enqueues).toEqual([]); // never enqueues
  });

  it('advanceWatermark shares the watermark with applyRemote (skipped echo blocks an older replay)', () => {
    const bus = createCommandBus(f.deps);
    // Self-echo skipped at opId 5 (advance only)...
    expect(bus.advanceWatermark(['bpm'], 5)).toBe(true);
    // ...so an older replayed op for the same path is now stale and does not write.
    expect(bus.applyRemote(broadcast(['bpm'], 99, 3))).toBe(false);
    expect(f.writes).toEqual([]);
    // ...and a newer op still applies.
    expect(bus.applyRemote(broadcast(['bpm'], 128, 6))).toBe(true);
    expect(f.writes).toEqual([{ path: ['bpm'], value: 128 }]);
  });

  it('resetWatermark also clears advanceWatermark state', () => {
    const bus = createCommandBus(f.deps);
    bus.advanceWatermark(['bpm'], 9);
    bus.resetWatermark();
    expect(bus.advanceWatermark(['bpm'], 1)).toBe(true); // fresh again
  });
});

describe('applied-command stream (Phase 5)', () => {
  it('subscribe sees a set AFTER the state write, then enqueue runs', () => {
    const calls: string[] = [];
    const state: Record<string, unknown> = {};
    const bus = createCommandBus({
      applySet: (path, value) => { state[String(path[0])] = value; calls.push('applySet'); },
      loadProject: () => { calls.push('loadProject'); },
      enqueue: () => { calls.push('enqueue'); },
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => {
      calls.push('emit');
      seen.push(cmd);
      // state is already written when the listener runs:
      expect(state.bpm).toBe(140);
    });
    bus.dispatchLocal({ path: ['bpm'], value: 140 });
    expect(calls).toEqual(['applySet', 'emit', 'enqueue']);
    expect(seen).toEqual([{ kind: 'set', path: ['bpm'], value: 140 }]);
  });

  it('applyRemote emits on apply, and does NOT emit on a stale watermark drop', () => {
    const state: Record<string, unknown> = {};
    const bus = createCommandBus({
      applySet: (path, value) => { state[String(path[0])] = value; },
      loadProject: () => {},
      enqueue: () => {},
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => seen.push(cmd));
    bus.applyRemote({ v: 1, type: 'set', opId: 5, path: ['bpm'], value: 130, clientId: 'x' } as never);
    bus.applyRemote({ v: 1, type: 'set', opId: 4, path: ['bpm'], value: 99, clientId: 'x' } as never); // stale
    expect(seen).toHaveLength(1);
  });

  it('applyRemote does NOT emit when applySet throws', () => {
    const bus = createCommandBus({
      applySet: () => { throw new Error('bad path'); },
      loadProject: () => {},
      enqueue: () => {},
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => seen.push(cmd));
    expect(bus.applyRemote({ v: 1, type: 'set', opId: 1, path: ['nope'], value: 1, clientId: 'x' } as never)).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('applyRollback writes + emits and never enqueues', () => {
    const state: Record<string, unknown> = {};
    const enqueue = vi.fn();
    const bus = createCommandBus({
      applySet: (path, value) => { state[String(path[0])] = value; },
      loadProject: () => {},
      enqueue,
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => seen.push(cmd));
    bus.applyRollback(['bpm'], 120);
    expect(state.bpm).toBe(120);
    expect(seen).toEqual([{ kind: 'set', path: ['bpm'], value: 120 }]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('loadProject calls deps.loadProject then emits a replace event', () => {
    const calls: string[] = [];
    const bus = createCommandBus({
      applySet: () => {},
      loadProject: () => { calls.push('loadProject'); },
      enqueue: () => {},
    });
    bus.subscribe((cmd) => { calls.push(cmd.kind); });
    bus.loadProject({} as never);
    expect(calls).toEqual(['loadProject', 'replace']);
  });

  it('unsubscribe stops delivery', () => {
    const bus = createCommandBus({ applySet: () => {}, loadProject: () => {}, enqueue: () => {} });
    const seen: unknown[] = [];
    const unsub = bus.subscribe((cmd) => seen.push(cmd));
    bus.dispatchLocal({ path: ['bpm'], value: 1 });
    unsub();
    bus.dispatchLocal({ path: ['bpm'], value: 2 });
    expect(seen).toHaveLength(1);
  });
});
