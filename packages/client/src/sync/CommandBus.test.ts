import { describe, it, expect, beforeEach } from 'vitest';
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
      enqueue: (path: Path) => { writes.push(path); },
    });
    expect(bus.applyRemote(broadcast(['tracks', 999, 'nope'], 1, 1))).toBe(false);
    expect(writes).toEqual([]);
  });
});
