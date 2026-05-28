import { describe, it, expect } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { InMemoryRoomStore } from './InMemoryRoomStore.js';

describe('InMemoryRoomStore', () => {
  it('creates a fresh room with opIdHead = 0 and a default Project', async () => {
    const store = new InMemoryRoomStore();
    const { project, opIdHead } = await store.getOrCreate('room1', freshProject);
    expect(opIdHead).toBe(0);
    expect(project.bpm).toBe(120);
    expect(project.tracks).toHaveLength(4);
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
    expect(dup).toEqual({ ok: false, reason: 'duplicate' });
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
