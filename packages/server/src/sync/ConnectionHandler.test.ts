import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROJECT_SCHEMA_VERSION, HANDLES, freshProject, TRACK_POOL_SIZE, STEP_BUFFER_SIZE } from '@fiddle/shared';
import { SESSION_LOAD_TIMEOUT_MS, HELLO_DEADLINE_MS } from './ConnectionHandler.js';
import { GRACE_MS } from '../room/RoomStore.js';
import type { ServerMessage } from '@fiddle/shared';
import { InMemoryRoomStore } from '../room/InMemoryRoomStore.js';
import { InMemoryProfileStore } from '../profile/InMemoryProfileStore.js';
import { ConnectionHandler } from './ConnectionHandler.js';
import type { RoomConnectionPool, SocketLike } from './SocketLike.js';

function fakeVerify(map: Record<string, { userId: string; googleName: string }>) {
  return async (token: string) => map[token] ?? null;
}

const rejectAll = async () => null;

type MockSocket = SocketLike & { sent: ServerMessage[]; closed: boolean };

function makeMockSocket(): MockSocket {
  const sent: ServerMessage[] = [];
  return {
    sent,
    closed: false,
    readyState: 1,
    send(m) {
      sent.push(m);
    },
    close() {
      this.closed = true;
      (this as { readyState: number }).readyState = 3;
    },
  };
}

class FakePool implements RoomConnectionPool {
  constructor(private sockets = new Map<string, SocketLike[]>()) {}
  add(roomId: string, s: SocketLike) {
    if (!this.sockets.has(roomId)) this.sockets.set(roomId, []);
    this.sockets.get(roomId)!.push(s);
  }
  others(roomId: string, exclude: SocketLike): SocketLike[] {
    return (this.sockets.get(roomId) ?? []).filter((s) => s !== exclude);
  }
  remove(roomId: string, s: SocketLike) {
    const arr = this.sockets.get(roomId);
    if (arr) this.sockets.set(roomId, arr.filter((x) => x !== s));
  }
  all(roomId: string): SocketLike[] {
    return this.sockets.get(roomId) ?? [];
  }
  size(roomId: string): number {
    return (this.sockets.get(roomId) ?? []).length;
  }
}

const noopLog = () => {};

describe('ConnectionHandler', () => {
  let store: InMemoryRoomStore;
  beforeEach(() => {
    store = new InMemoryRoomStore();
  });

  it('fresh hello → welcome + snapshot + sync.complete', async () => {
    const socket = makeMockSocket();
    const pool = new FakePool();
    pool.add('room1', socket);
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());

    await handler.onMessage({
      v: 1,
      type: 'hello',
      schemaVersion: PROJECT_SCHEMA_VERSION,
    });

    const types = socket.sent.map((m) => m.type);
    expect(types).toEqual(['welcome', 'snapshot', 'sync.complete']);

    const welcome = socket.sent[0];
    expect(welcome.type).toBe('welcome');
    if (welcome.type !== 'welcome') throw new Error('unreachable');
    expect(welcome.clientId).toMatch(/^c_/);
    expect(welcome.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(welcome.opIdHead).toBe(0);
    expect(welcome.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);

    const snapshot = socket.sent[1];
    if (snapshot.type !== 'snapshot') throw new Error('unreachable');
    expect(snapshot.opId).toBe(0);
    expect(snapshot.project.bpm).toBe(120);
  });

  it('rejects schema.version_mismatch as fatal', async () => {
    const socket = makeMockSocket();
    const pool = new FakePool();
    pool.add('room1', socket);
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());

    await handler.onMessage({
      v: 1,
      type: 'hello',
      schemaVersion: 9999,
    });

    const err = socket.sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    if (err && err.type === 'error') {
      expect(err.code).toBe('schema.version_mismatch');
      expect(err.fatal).toBe(true);
    }
    expect(socket.closed).toBe(true);
  });

  it('rejects unparseable first message', async () => {
    const socket = makeMockSocket();
    const pool = new FakePool();
    pool.add('room1', socket);
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());

    await handler.onMessage({ banana: true });

    expect(socket.closed).toBe(true);
    const err = socket.sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    if (err && err.type === 'error') {
      expect(err.fatal).toBe(true);
    }
  });

  it('resume with unknown clientId issues fresh identity + non-fatal error', async () => {
    const socket = makeMockSocket();
    const pool = new FakePool();
    pool.add('room1', socket);
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());

    await handler.onMessage({
      v: 1,
      type: 'hello',
      schemaVersion: PROJECT_SCHEMA_VERSION,
      clientId: 'c_unknown',
      resumeFromOpId: 0,
    });

    const welcome = socket.sent.find((m) => m.type === 'welcome');
    expect(welcome).toBeDefined();

    const errors = socket.sent.filter((m) => m.type === 'error');
    const unknown = errors.find(
      (m) => m.type === 'error' && m.code === 'resume.unknown_client',
    );
    expect(unknown).toBeDefined();
    if (unknown && unknown.type === 'error') {
      expect(unknown.fatal).toBe(false);
    }
    expect(socket.closed).toBe(false);
  });

  it('room.full fatally rejects 5th client', async () => {
    const pool = new FakePool();
    for (let i = 0; i < 4; i++) {
      pool.add('room1', makeMockSocket());
    }
    const socket = makeMockSocket();
    pool.add('room1', socket);

    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
    await handler.onMessage({
      v: 1,
      type: 'hello',
      schemaVersion: PROJECT_SCHEMA_VERSION,
    });

    const err = socket.sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    if (err && err.type === 'error') {
      expect(err.code).toBe('room.full');
      expect(err.fatal).toBe(true);
    }
    expect(socket.closed).toBe(true);
  });

  describe('presence on disconnect', () => {
    function clientIdOf(sock: MockSocket): string {
      const w = sock.sent.find((m) => m.type === 'welcome');
      if (!w || w.type !== 'welcome') throw new Error('no welcome');
      return w.clientId;
    }

    it('drops a departed client from the roster sent to remaining peers, but keeps its identity for resume', async () => {
      const sockA = makeMockSocket();
      const sockB = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', sockA);
      pool.add('room1', sockB);
      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handlerA.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      await handlerB.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      const aId = clientIdOf(sockA);
      const bId = clientIdOf(sockB);

      // B's welcome should list both live members.
      const bWelcome = sockB.sent.find((m) => m.type === 'welcome');
      if (!bWelcome || bWelcome.type !== 'welcome') throw new Error('unreachable');
      expect(bWelcome.roster.map((r) => r.clientId).sort()).toEqual([aId, bId].sort());

      sockA.sent.length = 0;
      sockB.sent.length = 0;

      // A disconnects. The route removes the socket from the pool before onClose.
      pool.remove('room1', sockA);
      await handlerA.onClose();

      // B is told the new roster, which now excludes A.
      const update = sockB.sent.find((m) => m.type === 'presence.update');
      expect(update).toBeDefined();
      if (!update || update.type !== 'presence.update') throw new Error('unreachable');
      expect(update.roster.map((r) => r.clientId)).toEqual([bId]);

      // A is gone from the live roster…
      const connected = await store.listConnected('room1');
      expect(connected.map((i) => i.clientId)).toEqual([bId]);
      // …but its identity is retained so a reconnect can resume it.
      expect(await store.getIdentity('room1', aId)).toBeDefined();
    });

    it('a reconnecting client resumes its identity and reappears in the roster', async () => {
      const sockA = makeMockSocket();
      const sockB = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', sockA);
      pool.add('room1', sockB);
      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handlerA.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      await handlerB.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      const aId = clientIdOf(sockA);

      pool.remove('room1', sockA);
      await handlerA.onClose();
      expect((await store.listConnected('room1')).map((i) => i.clientId)).not.toContain(aId);

      // A reconnects on a new socket with its stored clientId.
      const sockA2 = makeMockSocket();
      pool.add('room1', sockA2);
      const handlerA2 = new ConnectionHandler('room1', sockA2, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handlerA2.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
        clientId: aId,
        resumeFromOpId: 0,
      });

      const w = sockA2.sent.find((m) => m.type === 'welcome');
      if (!w || w.type !== 'welcome') throw new Error('unreachable');
      expect(w.clientId).toBe(aId); // same identity resumed, not a fresh one
      // No unknown_client warning — the identity survived.
      expect(sockA2.sent.find((m) => m.type === 'error' && m.code === 'resume.unknown_client')).toBeUndefined();
      // A is live again.
      expect((await store.listConnected('room1')).map((i) => i.clientId)).toContain(aId);
    });
  });

  describe('grace expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('last-socket close fires the injected onGraceExpire after GRACE_MS (room end-of-life is delegated)', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const onGraceExpire = vi.fn(async () => {});
      const handler = new ConnectionHandler(
        'room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        undefined, undefined, onGraceExpire,
      );
      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      pool.remove('room1', socket);
      await handler.onClose();
      expect(onGraceExpire).not.toHaveBeenCalled(); // grace window, not socket close

      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(onGraceExpire).toHaveBeenCalledWith('room1');
      // pruneRoom is the delegate's job now — the handler must not race it.
      expect(await store.peekProject('room1')).not.toBeNull();
    });

    it('without an injected onGraceExpire, the default still prunes the in-memory room', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      pool.remove('room1', socket);
      await handler.onClose();
      expect(await store.peekProject('room1')).not.toBeNull();

      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(await store.peekProject('room1')).toBeNull();
    });
  });

  describe('set op handling', () => {
    async function helloOne(): Promise<{
      socket: MockSocket;
      pool: FakePool;
      handler: ConnectionHandler;
    }> {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handler.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
      });
      // Drain hello-phase frames so subsequent assertions see only op output.
      socket.sent.length = 0;
      return { socket, pool, handler };
    }

    it('valid set op is appended and broadcast (with clientSeq echo)', async () => {
      const { socket, handler } = await helloOne();
      await handler.onMessage({
        v: 1,
        type: 'set',
        clientSeq: 1,
        path: ['bpm'],
        value: 140,
      });

      const set = socket.sent.find((m) => m.type === 'set');
      expect(set).toBeDefined();
      if (!set || set.type !== 'set') throw new Error('unreachable');
      expect(set.opId).toBe(1);
      expect(set.clientSeq).toBe(1);
      expect(set.value).toBe(140);
      expect(set.path).toEqual(['bpm']);
    });

    it('invalid path is nacked with path.invalid', async () => {
      const { socket, handler } = await helloOne();
      await handler.onMessage({
        v: 1,
        type: 'set',
        clientSeq: 1,
        path: ['schemaVersion'],
        value: 99,
      });

      const nack = socket.sent.find((m) => m.type === 'nack');
      expect(nack).toBeDefined();
      if (!nack || nack.type !== 'nack') throw new Error('unreachable');
      expect(nack.code).toBe('path.invalid');
      expect(nack.clientSeq).toBe(1);
      // And nothing was broadcast.
      expect(socket.sent.find((m) => m.type === 'set')).toBeUndefined();
    });

    it('out-of-range track index is nacked with path.invalid (not crashed)', async () => {
      const { socket, handler } = await helloOne();
      await handler.onMessage({
        v: 1,
        type: 'set',
        clientSeq: 1,
        path: ['tracks', 99, 'engineType'],
        value: 'synth',
      });

      const nack = socket.sent.find((m) => m.type === 'nack');
      expect(nack).toBeDefined();
      if (!nack || nack.type !== 'nack') throw new Error('unreachable');
      expect(nack.code).toBe('path.invalid');
      expect(nack.clientSeq).toBe(1);
      // The op must not have been appended/broadcast.
      expect(socket.sent.find((m) => m.type === 'set')).toBeUndefined();
    });

    it('invalid value is nacked with value.invalid', async () => {
      const { socket, handler } = await helloOne();
      await handler.onMessage({
        v: 1,
        type: 'set',
        clientSeq: 1,
        path: ['bpm'],
        value: 9999,
      });

      const nack = socket.sent.find((m) => m.type === 'nack');
      expect(nack).toBeDefined();
      if (!nack || nack.type !== 'nack') throw new Error('unreachable');
      expect(nack.code).toBe('value.invalid');
      expect(nack.clientSeq).toBe(1);
      expect(socket.sent.find((m) => m.type === 'set')).toBeUndefined();
    });

    it('a duplicate set is echoed (not nacked) to the originator', async () => {
      const { socket, handler } = await helloOne();
      // First apply: server stores value 140 at some opId and echoes it back.
      await handler.onMessage({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 140 });
      const firstSet = socket.sent.find((m) => m.type === 'set');
      expect(firstSet).toBeDefined();
      if (!firstSet || firstSet.type !== 'set') throw new Error('unreachable');
      const firstOpId = firstSet.opId;

      // Resend the same clientSeq (a lost-echo retry), this time with a different
      // value — the server must recognise the duplicate and echo its STORED op,
      // not re-apply the resent value or nack it.
      await handler.onMessage({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 142 });

      const sets = socket.sent.filter((m) => m.type === 'set');
      expect(sets).toHaveLength(2); // first apply + a duplicate echo (NOT a nack)
      expect(socket.sent.some((m) => m.type === 'nack')).toBe(false);
      const echo = sets[1];
      if (echo.type !== 'set') throw new Error('unreachable');
      // Echo carries the original opId + value and the incoming clientSeq.
      expect(echo.opId).toBe(firstOpId);
      expect(echo.clientSeq).toBe(1);
      expect(echo.value).toBe(140); // server's stored value, not the resent 142
    });

    it('broadcast hides clientSeq from non-originators', async () => {
      // Set up two clients in the same room.
      const sockA = makeMockSocket();
      const sockB = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', sockA);
      pool.add('room1', sockB);

      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handlerA.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
      });
      await handlerB.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
      });
      sockA.sent.length = 0;
      sockB.sent.length = 0;

      await handlerA.onMessage({
        v: 1,
        type: 'set',
        clientSeq: 42,
        path: ['bpm'],
        value: 132,
      });

      const setA = sockA.sent.find((m) => m.type === 'set');
      const setB = sockB.sent.find((m) => m.type === 'set');
      expect(setA).toBeDefined();
      expect(setB).toBeDefined();
      if (!setA || setA.type !== 'set') throw new Error('unreachable');
      if (!setB || setB.type !== 'set') throw new Error('unreachable');
      expect(setA.clientSeq).toBe(42);
      expect(setB.clientSeq).toBeUndefined();
      // Both should see the same opId + value.
      expect(setA.opId).toBe(setB.opId);
      expect(setA.value).toBe(132);
      expect(setB.value).toBe(132);
    });
  });

  describe('hello auth', () => {
    function welcomeOf(sock: MockSocket) {
      const w = sock.sent.find((m) => m.type === 'welcome');
      if (!w || w.type !== 'welcome') throw new Error('no welcome');
      return w;
    }

    it('uses the stored username as the handle for an authenticated user', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const profiles = new InMemoryProfileStore({ 'user-1': 'DJ Eugene' });
      const verify = fakeVerify({ 'good-token': { userId: 'user-1', googleName: 'Eugene B' } });
      const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, verify, profiles);

      await handler.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
        token: 'good-token',
      });

      const welcome = welcomeOf(socket);
      expect(welcome.handle).toBe('DJ Eugene');
      expect(welcome.authenticated).toBe(true);
      expect(welcome.userId).toBe('user-1');
    });

    it('falls back to the Google name when no username is stored', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const profiles = new InMemoryProfileStore(); // empty
      const verify = fakeVerify({ 'good-token': { userId: 'user-1', googleName: 'Eugene B' } });
      const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, verify, profiles);

      await handler.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
        token: 'good-token',
      });

      const welcome = welcomeOf(socket);
      expect(welcome.handle).toBe('Eugene B');
      expect(welcome.authenticated).toBe(true);
    });

    it('rejects an invalid token fatally with auth.invalid and no welcome', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const handler = new ConnectionHandler(
        'room1',
        socket,
        store,
        pool,
        noopLog,
        rejectAll,
        new InMemoryProfileStore(),
      );

      await handler.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
        token: 'bad',
      });

      const err = socket.sent.find((m) => m.type === 'error');
      expect(err).toBeDefined();
      if (err && err.type === 'error') {
        expect(err.code).toBe('auth.invalid');
        expect(err.fatal).toBe(true);
      }
      expect(socket.closed).toBe(true);
      expect(socket.sent.find((m) => m.type === 'welcome')).toBeUndefined();
    });

    it('leaves the guest path unchanged when no token is supplied', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const verify = fakeVerify({ 'good-token': { userId: 'user-1', googleName: 'Eugene B' } });
      const handler = new ConnectionHandler(
        'room1',
        socket,
        store,
        pool,
        noopLog,
        verify,
        new InMemoryProfileStore({ 'user-1': 'DJ Eugene' }),
      );

      await handler.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
      });

      const welcome = welcomeOf(socket);
      expect(welcome.authenticated).toBeFalsy();
      expect((HANDLES as readonly string[]).includes(welcome.handle)).toBe(true);
    });

    it('mints a per-connection-unique clientId for multi-tab same-user sessions', async () => {
      const verify = fakeVerify({ 'good-token': { userId: 'user-1', googleName: 'Eugene B' } });
      const profiles = new InMemoryProfileStore({ 'user-1': 'DJ Eugene' });

      const sockA = makeMockSocket();
      const sockB = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', sockA);
      pool.add('room1', sockB);
      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog, verify, profiles);
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog, verify, profiles);

      await handlerA.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
        token: 'good-token',
      });
      await handlerB.onMessage({
        v: 1,
        type: 'hello',
        schemaVersion: PROJECT_SCHEMA_VERSION,
        token: 'good-token',
      });

      const aId = welcomeOf(sockA).clientId;
      const bId = welcomeOf(sockB).clientId;
      expect(aId).not.toBe(bId);

      const connected = await store.listConnected('room1');
      expect(connected.map((i) => i.clientId).sort()).toEqual([aId, bId].sort());
      // Both carry the same account.
      expect(connected.every((i) => i.userId === 'user-1')).toBe(true);

      // Closing one tab leaves the other live.
      pool.remove('room1', sockA);
      await handlerA.onClose();
      const stillConnected = await store.listConnected('room1');
      expect(stillConnected.map((i) => i.clientId)).toEqual([bId]);
    });
  });

  describe('session-scoped room init (Plan 3)', () => {
    it('rejects a hello for an unknown session with fatal session.not_found', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('ghost', socket);
      const handler = new ConnectionHandler(
        'ghost', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        async () => null,
      );

      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      const err = socket.sent.find((m) => m.type === 'error');
      expect(err && err.type === 'error' && err.code).toBe('session.not_found');
      expect(err && err.type === 'error' && err.fatal).toBe(true);
      expect(socket.closed).toBe(true);
      expect(socket.sent.find((m) => m.type === 'welcome')).toBeUndefined();
    });

    it('rejects fast with a fatal overloaded when the session load hangs', async () => {
      vi.useFakeTimers();
      try {
        const socket = makeMockSocket();
        const pool = new FakePool();
        pool.add('slow', socket);
        // Loader that never settles — mimics a wedged DB pooler. Without the
        // timeout the client would wait for a welcome that never comes.
        const handler = new ConnectionHandler(
          'slow', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
          () => new Promise<never>(() => {}),
        );

        const p = handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
        await vi.advanceTimersByTimeAsync(SESSION_LOAD_TIMEOUT_MS + 1);
        await p;

        const err = socket.sent.find((m) => m.type === 'error');
        expect(err && err.type === 'error' && err.code).toBe('overloaded');
        expect(err && err.type === 'error' && err.fatal).toBe(true);
        expect(socket.closed).toBe(true);
        expect(socket.sent.find((m) => m.type === 'welcome')).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects with a fatal overloaded when the session load throws', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('err', socket);
      const handler = new ConnectionHandler(
        'err', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        async () => { throw new Error('db down'); },
      );

      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      const err = socket.sent.find((m) => m.type === 'error');
      expect(err && err.type === 'error' && err.code).toBe('overloaded');
      expect(err && err.type === 'error' && err.fatal).toBe(true);
      expect(socket.closed).toBe(true);
      expect(socket.sent.find((m) => m.type === 'welcome')).toBeUndefined();
    });

    it('seeds the room snapshot from the session loader', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('seeded', socket);
      const seeded = freshProject();
      seeded.bpm = 171;
      const handler = new ConnectionHandler(
        'seeded', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        async () => ({ project: seeded }),
      );

      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      const snap = socket.sent.find((m) => m.type === 'snapshot');
      expect(snap && snap.type === 'snapshot' && snap.project.bpm).toBe(171);
    });

    it('normalizes a legacy 4-track session to the full pool before serving', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('legacy', socket);
      const legacy = freshProject();
      legacy.tracks = legacy.tracks.slice(0, 4); // pre-pool stored project
      const handler = new ConnectionHandler(
        'legacy', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        async () => ({ project: legacy }),
      );

      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      const snap = socket.sent.find((m) => m.type === 'snapshot');
      expect(snap).toBeDefined();
      if (!snap || snap.type !== 'snapshot') throw new Error('unreachable');
      const servedProject = snap.project;
      expect(servedProject.tracks).toHaveLength(TRACK_POOL_SIZE);
      expect(servedProject.tracks.slice(0, 4).every((t) => t.enabled)).toBe(true);
    });

    it('deep-repairs a legacy 16-step session before serving (D2)', async () => {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('legacy16', socket);
      const legacy = freshProject();
      legacy.tracks.forEach((t) => { (t as { steps: unknown }).steps = t.steps.slice(0, 16); });
      legacy.tracks[0].steps[3].note = 'C';
      const handler = new ConnectionHandler(
        'legacy16', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        async () => ({ project: legacy }),
      );

      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

      const snap = socket.sent.find((m) => m.type === 'snapshot');
      if (!snap || snap.type !== 'snapshot') throw new Error('unreachable');
      // Every track served over the wire carries the full step buffer…
      expect(snap.project.tracks.every((t) => t.steps.length === STEP_BUFFER_SIZE)).toBe(true);
      // …with stored steps kept in place, so patterns survive the migration.
      expect(snap.project.tracks[0].steps[3].note).toBe('C');

      // The in-memory room is dense too: an op past the legacy length lands in
      // a real step object instead of creating a sparse array via setDeep.
      await handler.onMessage({ v: 1, type: 'set', clientSeq: 1, path: ['tracks', 0, 'steps', 40, 'note'], value: 'E' });
      const room = await store.peekProject('legacy16');
      expect(room!.tracks[0].steps[40]).toMatchObject({ note: 'E', velocity: expect.any(Number) });
    });
  });

  it('resync replays ops since fromOpId then sync.complete', async () => {
    const socket = makeMockSocket();
    const pool = new FakePool();
    pool.add('room1', socket);
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
    await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

    // Apply two ops so the room head advances to opId 2.
    await handler.onMessage({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 130 });
    await handler.onMessage({ v: 1, type: 'set', clientSeq: 2, path: ['bpm'], value: 131 });
    socket.sent.length = 0;

    // Client claims it only applied up to opId 1 → expects op 2 replayed.
    await handler.onMessage({ v: 1, type: 'resync', fromOpId: 1 });

    const replayed = socket.sent.filter((m) => m.type === 'set');
    expect(replayed.map((m) => (m.type === 'set' ? m.opId : -1))).toEqual([2]);
    expect(socket.sent.at(-1)!.type).toBe('sync.complete');
  });

  describe('hello deadline', () => {
    it('closes a connection that never completes hello after the deadline', () => {
      vi.useFakeTimers();
      try {
        const socket = makeMockSocket();
        const pool = new FakePool();
        pool.add('idle', socket);
        const handler = new ConnectionHandler(
          'idle', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        );
        handler.onOpen();
        expect(socket.closed).toBe(false);
        vi.advanceTimersByTime(HELLO_DEADLINE_MS + 1);
        expect(socket.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not close once hello completes before the deadline', async () => {
      vi.useFakeTimers();
      try {
        const socket = makeMockSocket();
        const pool = new FakePool();
        pool.add('room1', socket);
        const handler = new ConnectionHandler(
          'room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore(),
        );
        handler.onOpen();
        await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
        vi.advanceTimersByTime(HELLO_DEADLINE_MS + 1);
        expect(socket.closed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
