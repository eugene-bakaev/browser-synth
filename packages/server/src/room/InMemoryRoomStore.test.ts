import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshProject, TRACK_POOL_SIZE } from '@fiddle/shared';
import { InMemoryRoomStore } from './InMemoryRoomStore.js';
import { GRACE_MS } from './RoomStore.js';

describe('InMemoryRoomStore.appendOp dedupe', () => {
  it('returns the original op when the same (clientId, clientSeq) is re-appended', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r', freshProject);

    const first = await store.appendOp('r', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 130 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    const dup = await store.appendOp('r', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 130 });
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error('unreachable');
    expect(dup.reason).toBe('duplicate');
    expect(dup.op).toEqual(first.op); // carries the already-applied op
  });
});

describe('InMemoryRoomStore', () => {
  it('creates a fresh room with opIdHead = 0 and a default Project', async () => {
    const store = new InMemoryRoomStore();
    const { project, opIdHead } = await store.getOrCreate('room1', freshProject);
    expect(opIdHead).toBe(0);
    expect(project.bpm).toBe(120);
    expect(project.tracks).toHaveLength(TRACK_POOL_SIZE);
  });

  it('assigns sequential opIds when appending ops', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);

    const r1 = await store.appendOp('room1', {
      clientId: 'c1',
      clientSeq: 1,
      path: ['bpm'],
      value: 140,
    });
    const r2 = await store.appendOp('room1', {
      clientId: 'c1',
      clientSeq: 2,
      path: ['bpm'],
      value: 150,
    });

    expect(r1).toEqual({ ok: true, op: expect.objectContaining({ opId: 1 }) });
    expect(r2).toEqual({ ok: true, op: expect.objectContaining({ opId: 2 }) });
  });

  it('detects duplicates by (clientId, clientSeq)', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    await store.appendOp('room1', {
      clientId: 'c1',
      clientSeq: 1,
      path: ['bpm'],
      value: 140,
    });
    const dup = await store.appendOp('room1', {
      clientId: 'c1',
      clientSeq: 1,
      path: ['bpm'],
      value: 999,
    });
    expect(dup).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('getOpsSince(0) returns the full log', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    await store.appendOp('room1', {
      clientId: 'c1',
      clientSeq: 1,
      path: ['bpm'],
      value: 140,
    });
    await store.appendOp('room1', {
      clientId: 'c1',
      clientSeq: 2,
      path: ['bpm'],
      value: 150,
    });

    const ops = await store.getOpsSince('room1', 0);
    expect(ops).toEqual(expect.any(Array));
    expect(ops).toHaveLength(2);
    expect(ops![0]!.opId).toBe(1);
    expect(ops![1]!.opId).toBe(2);
  });

  it('evicts the oldest op once the ring buffer overflows', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    for (let i = 1; i <= 1001; i++) {
      await store.appendOp('room1', {
        clientId: 'c1',
        clientSeq: i,
        path: ['bpm'],
        value: 120 + (i % 60),
      });
    }
    // Op with opId = 1 should be gone; oldest is opId 2.
    expect(await store.getOpsSince('room1', 0)).toBeNull();
    const tail = await store.getOpsSince('room1', 1000);
    expect(tail).toEqual(expect.any(Array));
    expect(tail).toHaveLength(1);
    expect(tail![0]!.opId).toBe(1001);
  });

  it('dedup index follows ring-buffer eviction', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    for (let i = 1; i <= 1001; i++) {
      await store.appendOp('room1', { clientId: 'c1', clientSeq: i, path: ['bpm'], value: 120 + (i % 60) });
    }
    // seq 1's op was evicted from the ring, so re-appending it is treated as
    // NEW (same as the old scan behavior) — proving its index entry was
    // evicted in the same splice rather than left to dedup forever.
    const revived = await store.appendOp('room1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 125 });
    expect(revived.ok).toBe(true);
    // An op still inside the ring keeps deduping.
    const dup = await store.appendOp('room1', { clientId: 'c1', clientSeq: 500, path: ['bpm'], value: 999 });
    expect(dup).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('round-trips identities', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    await store.setIdentity('room1', {
      clientId: 'c1',
      color: '#FF4136',
      handle: 'Owl',
    });
    expect(await store.getIdentity('room1', 'c1')).toEqual({
      clientId: 'c1',
      color: '#FF4136',
      handle: 'Owl',
    });
    expect(await store.listIdentities('room1')).toHaveLength(1);
    await store.removeIdentity('room1', 'c1');
    expect(await store.getIdentity('room1', 'c1')).toBeUndefined();
    expect(await store.listIdentities('room1')).toHaveLength(0);
  });

  it('listConnected reflects live presence, independent of the identity registry', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    await store.setIdentity('room1', { clientId: 'c1', color: '#FF4136', handle: 'Owl' });
    await store.setIdentity('room1', { clientId: 'c2', color: '#0074D9', handle: 'Fox' });

    // Identities exist but no one is marked connected yet.
    expect(await store.listConnected('room1')).toHaveLength(0);

    await store.markConnected('room1', 'c1');
    await store.markConnected('room1', 'c2');
    expect((await store.listConnected('room1')).map((i) => i.clientId)).toEqual(['c1', 'c2']);

    // c1 disconnects: drops from presence, but its identity is retained for resume.
    await store.markDisconnected('room1', 'c1');
    expect((await store.listConnected('room1')).map((i) => i.clientId)).toEqual(['c2']);
    expect(await store.getIdentity('room1', 'c1')).toBeDefined();

    // Reconnect re-adds c1 to presence without a new identity.
    await store.markConnected('room1', 'c1');
    expect((await store.listConnected('room1')).map((i) => i.clientId).sort()).toEqual(['c1', 'c2']);
  });

  it('removeIdentity also clears live presence', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    await store.setIdentity('room1', { clientId: 'c1', color: '#FF4136', handle: 'Owl' });
    await store.markConnected('room1', 'c1');
    await store.removeIdentity('room1', 'c1');
    expect(await store.listConnected('room1')).toHaveLength(0);
  });

  it('pruneRoom drops the room', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('room1', freshProject);
    await store.pruneRoom('room1');
    await expect(
      store.appendOp('room1', {
        clientId: 'c1',
        clientSeq: 1,
        path: ['bpm'],
        value: 140,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('InMemoryRoomStore version-gated clearDirty', () => {
  it('bumps version per op and only clears dirty when version is unchanged', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r', freshProject);
    await store.appendOp('r', { clientId: 'c', clientSeq: 1, path: ['bpm'], value: 130 });
    const v1 = await store.roomVersion('r');

    // An op lands after we captured v1 (simulates a mid-flush write).
    await store.appendOp('r', { clientId: 'c', clientSeq: 2, path: ['bpm'], value: 131 });

    await store.clearDirty('r', v1!);                 // stale version → must NOT clear
    expect(await store.listDirtyRoomIds()).toContain('r');

    const v2 = await store.roomVersion('r');
    await store.clearDirty('r', v2!);                 // current version → clears
    expect(await store.listDirtyRoomIds()).not.toContain('r');
  });
});

describe('InMemoryRoomStore.replaceProject', () => {
  it('swaps the doc, advances head, and clears replayability', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    await store.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 97 });
    const headBefore = (await store.getOrCreate('r1', freshProject)).opIdHead;

    const next = freshProject();
    next.bpm = 63;
    const { opId } = await store.replaceProject('r1', next);

    expect(opId).toBe(headBefore + 1);
    const { project, opIdHead } = await store.getOrCreate('r1', freshProject);
    expect(project.bpm).toBe(63);
    expect(opIdHead).toBe(opId);
    // Pre-load watermarks must take the snapshot path…
    expect(await store.getOpsSince('r1', headBefore)).toBeNull();
    expect(await store.getOpsSince('r1', 0)).toBeNull();
    // …but a client already at the new head needs nothing.
    expect(await store.getOpsSince('r1', opId)).toEqual([]);
  });

  it('marks the room dirty and bumps version (autosave contract)', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    const v0 = await store.roomVersion('r1');
    await store.clearDirty('r1');
    await store.replaceProject('r1', freshProject());
    expect(await store.listDirtyRoomIds()).toContain('r1');
    expect(await store.roomVersion('r1')).toBe((v0 ?? 0) + 1);
  });

  it('appendOp after a load continues the opId sequence', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    const { opId } = await store.replaceProject('r1', freshProject());
    const r = await store.appendOp('r1', { clientId: 'c1', clientSeq: 2, path: ['bpm'], value: 80 });
    expect(r.ok && r.op.opId).toBe(opId + 1);
  });
});

describe('InMemoryRoomStore grace lifecycle (M3a)', () => {
  let store: InMemoryRoomStore;
  beforeEach(() => {
    store = new InMemoryRoomStore();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancelGrace is a no-op for an unknown room (hello settles grace before the room exists)', async () => {
    await expect(store.cancelGrace('nope')).resolves.toBeUndefined();
  });

  it('cancelGrace before expiry stops the timer (onExpire never runs)', async () => {
    await store.getOrCreate('r', freshProject);
    const onExpire = vi.fn();
    await store.startGrace('r', onExpire);
    await store.cancelGrace('r');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('cancelGrace waits out an in-flight async expiry chain', async () => {
    await store.getOrCreate('r', freshProject);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const order: string[] = [];
    await store.startGrace('r', async () => {
      order.push('expiry start');
      await gate; // simulates the flush / DB work in SessionSync.handleGraceExpiry
      await store.pruneRoom('r');
      order.push('expiry done');
    });

    await vi.advanceTimersByTimeAsync(GRACE_MS); // timer fires; chain parks on the gate
    const cancelled = store.cancelGrace('r').then(() => order.push('cancel resolved'));
    release();
    await cancelled;

    // cancelGrace must resolve only after the teardown finished — the caller
    // sees a fully-pruned room, never a half-expired one.
    expect(order).toEqual(['expiry start', 'expiry done', 'cancel resolved']);
    expect(await store.peekProject('r')).toBeNull();
  });

  it('a rejected expiry chain still settles cancelGrace (no unhandled rejection)', async () => {
    await store.getOrCreate('r', freshProject);
    await store.startGrace('r', async () => {
      throw new Error('flush failed');
    });
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await expect(store.cancelGrace('r')).resolves.toBeUndefined();
  });
});
