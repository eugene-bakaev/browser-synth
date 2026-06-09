import { describe, it, expect } from 'vitest';
import { freshProject, TRACK_POOL_SIZE } from '@fiddle/shared';
import { InMemoryRoomStore } from './InMemoryRoomStore.js';

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
