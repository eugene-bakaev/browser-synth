import { describe, it, expect, beforeEach } from 'vitest';
import { PROJECT_SCHEMA_VERSION } from '@fiddle/shared';
import type { ServerMessage } from '@fiddle/shared';
import { InMemoryRoomStore } from '../room/InMemoryRoomStore.js';
import { ConnectionHandler } from './ConnectionHandler.js';
import type { RoomConnectionPool, SocketLike } from './SocketLike.js';

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
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog);

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
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog);

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
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog);

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
    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog);

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

    const handler = new ConnectionHandler('room1', socket, store, pool, noopLog);
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
      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog);
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog);
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
      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog);
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog);
      await handlerA.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      await handlerB.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      const aId = clientIdOf(sockA);

      pool.remove('room1', sockA);
      await handlerA.onClose();
      expect((await store.listConnected('room1')).map((i) => i.clientId)).not.toContain(aId);

      // A reconnects on a new socket with its stored clientId.
      const sockA2 = makeMockSocket();
      pool.add('room1', sockA2);
      const handlerA2 = new ConnectionHandler('room1', sockA2, store, pool, noopLog);
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

  describe('set op handling', () => {
    async function helloOne(): Promise<{
      socket: MockSocket;
      pool: FakePool;
      handler: ConnectionHandler;
    }> {
      const socket = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', socket);
      const handler = new ConnectionHandler('room1', socket, store, pool, noopLog);
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

    it('duplicate clientSeq is nacked with op.duplicate', async () => {
      const { socket, handler } = await helloOne();
      await handler.onMessage({
        v: 1,
        type: 'set',
        clientSeq: 1,
        path: ['bpm'],
        value: 140,
      });
      // First one should have broadcast.
      expect(socket.sent.find((m) => m.type === 'set')).toBeDefined();
      socket.sent.length = 0;

      await handler.onMessage({
        v: 1,
        type: 'set',
        clientSeq: 1,
        path: ['bpm'],
        value: 142,
      });

      const nack = socket.sent.find((m) => m.type === 'nack');
      expect(nack).toBeDefined();
      if (!nack || nack.type !== 'nack') throw new Error('unreachable');
      expect(nack.code).toBe('op.duplicate');
      expect(nack.clientSeq).toBe(1);
      // No re-broadcast on dedup.
      expect(socket.sent.find((m) => m.type === 'set')).toBeUndefined();
    });

    it('broadcast hides clientSeq from non-originators', async () => {
      // Set up two clients in the same room.
      const sockA = makeMockSocket();
      const sockB = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', sockA);
      pool.add('room1', sockB);

      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog);
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog);
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
});
