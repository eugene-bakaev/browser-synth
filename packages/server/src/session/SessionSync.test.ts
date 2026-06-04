import { describe, it, expect, vi } from 'vitest';
import { freshProject, DEFAULT_SESSION_SETTINGS, PROJECT_SCHEMA_VERSION } from '@fiddle/shared';
import { InMemoryRoomStore } from '../room/InMemoryRoomStore.js';
import { InMemorySessionStore } from './InMemorySessionStore.js';
import { SessionSync } from './SessionSync.js';
import type { CreateSessionInput } from './SessionStore.js';

function sessionInput(over: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id: 'r1', name: 'Jam', description: '', ownerUserId: 'u1', ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS, project: freshProject(), ...over,
  };
}

describe('SessionSync', () => {
  it('flushRoom persists the live project and clears dirty', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput());
    await rooms.getOrCreate('r1', freshProject);
    await rooms.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 155 });

    const sync = new SessionSync(rooms, sessions);
    await sync.flushRoom('r1');

    expect((await sessions.getSnapshot('r1'))?.bpm).toBe(155);
    expect(await rooms.listDirtyRoomIds()).toEqual([]);
  });

  it('flushRoom repairs an invalid project (0 enabled tracks) before persisting', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput({ id: 'r1' }));
    // Seed the room with the "test 222" corruption: a 32-slot pool with every
    // track disabled. The server must never persist a 0-track project.
    const broken = freshProject();
    broken.tracks.forEach(t => { t.enabled = false; });
    await rooms.getOrCreate('r1', () => broken);

    const sync = new SessionSync(rooms, sessions);
    await sync.flushRoom('r1');

    const saved = await sessions.getSnapshot('r1');
    expect(saved!.tracks.filter(t => t.enabled).length).toBeGreaterThanOrEqual(1);
    expect(saved!.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('flushAllDirty flushes only dirty rooms', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput({ id: 'r1' }));
    await sessions.create(sessionInput({ id: 'r2' }));
    await rooms.getOrCreate('r1', freshProject);
    await rooms.getOrCreate('r2', freshProject);
    await rooms.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 99 });
    // r2 is left clean.

    const sync = new SessionSync(rooms, sessions);
    await sync.flushAllDirty();

    expect((await sessions.getSnapshot('r1'))?.bpm).toBe(99);
    expect((await sessions.getSnapshot('r2'))?.bpm).toBe(freshProject().bpm); // untouched
  });

  it('handleDisconnect flushes, then prunes a guest session when the room empties', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput({ id: 'g', ownerUserId: null, ownerClientId: 'c1' }));
    await rooms.getOrCreate('g', freshProject);
    await rooms.appendOp('g', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 120 });

    const sync = new SessionSync(rooms, sessions);
    await sync.handleDisconnect('g', true);

    expect(await sessions.get('g')).toBeNull();
    expect(await sessions.getSnapshot('g')).toBeNull();
  });

  it('handleDisconnect keeps a logged-in session when the room empties', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    await sessions.create(sessionInput({ id: 'r1', ownerUserId: 'u1' }));
    await rooms.getOrCreate('r1', freshProject);
    await rooms.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 88 });

    const sync = new SessionSync(rooms, sessions);
    await sync.handleDisconnect('r1', true);

    expect(await sessions.get('r1')).not.toBeNull();
    expect((await sessions.getSnapshot('r1'))?.bpm).toBe(88);
  });

  it('flushRoom on a pruned/unknown room is a no-op', async () => {
    const rooms = new InMemoryRoomStore();
    const sessions = new InMemorySessionStore();
    const sync = new SessionSync(rooms, sessions);
    await expect(sync.flushRoom('ghost')).resolves.toBeUndefined();
  });

  it('flushAllDirty leaves the dirty flag set (and continues) when saveSnapshot fails', async () => {
    const rooms = new InMemoryRoomStore();
    // Real store, but saveSnapshot rejects only for the failing room (r1).
    const sessions = new InMemorySessionStore();
    const realSave = sessions.saveSnapshot.bind(sessions);
    sessions.saveSnapshot = vi.fn(async (id: string, project) => {
      if (id === 'r1') throw new Error('boom');
      return realSave(id, project);
    });

    await sessions.create(sessionInput({ id: 'r1' }));
    await sessions.create(sessionInput({ id: 'r2' }));
    await rooms.getOrCreate('r1', freshProject);
    await rooms.getOrCreate('r2', freshProject);
    await rooms.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 77 });
    await rooms.appendOp('r2', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 66 });

    const sync = new SessionSync(rooms, sessions);
    // Does not throw — the error is caught inside flushRoom.
    await expect(sync.flushAllDirty()).resolves.toBeUndefined();

    // r1 stays dirty so the next sweep retries; r2 flushed past the failure.
    expect(await rooms.listDirtyRoomIds()).toEqual(['r1']);
    expect((await sessions.getSnapshot('r2'))?.bpm).toBe(66);
  });

  it('start schedules the sweep; stop clears it', () => {
    vi.useFakeTimers();
    try {
      const rooms = new InMemoryRoomStore();
      const sessions = new InMemorySessionStore();
      const sync = new SessionSync(rooms, sessions);
      const spy = vi.spyOn(sync, 'flushAllDirty').mockResolvedValue();
      sync.start();
      vi.advanceTimersByTime(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      sync.stop();
      vi.advanceTimersByTime(120_000);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
