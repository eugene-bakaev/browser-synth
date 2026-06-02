import { describe, it, expect } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { InMemoryRoomStore } from './InMemoryRoomStore.js';

describe('InMemoryRoomStore persistence/presence helpers', () => {
  it('appendOp marks the room dirty; clearDirty clears it', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    expect(await store.listDirtyRoomIds()).toEqual([]);
    await store.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 130 });
    expect(await store.listDirtyRoomIds()).toEqual(['r1']);
    await store.clearDirty('r1');
    expect(await store.listDirtyRoomIds()).toEqual([]);
  });

  it('peekProject returns the live project and null for a missing room', async () => {
    const store = new InMemoryRoomStore();
    expect(await store.peekProject('nope')).toBeNull();
    await store.getOrCreate('r1', freshProject);
    await store.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 142 });
    expect((await store.peekProject('r1'))?.bpm).toBe(142);
  });

  it('roomMemberCounts reflects connected sockets per existing room', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    await store.markConnected('r1', 'c1');
    await store.markConnected('r1', 'c2');
    await store.getOrCreate('r2', freshProject);
    const counts = await store.roomMemberCounts();
    expect(counts.get('r1')).toBe(2);
    expect(counts.get('r2')).toBe(0);
  });
});
