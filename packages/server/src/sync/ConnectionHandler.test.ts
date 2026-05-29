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
});
