import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { freshProject } from '../project';
import { SyncSession, type SyncSessionDeps } from './SyncSession';

// A fake WsClient matching the surface SyncSession/messageDispatch touch. The
// factory captures opts so the test can push server messages via opts.onMessage.
function makeFakeWsClient(opts: any) {
  let seq = 0;
  return {
    _opts: opts,
    sent: [] as any[],
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    send(op: any) { this.sent.push(op); },
    isLive: () => true,
    nextClientSeq: () => ++seq,
    recordOpIdSeen: vi.fn(),
    opIdLastSeen: vi.fn(() => 0),
    requestResync: vi.fn(),
    getPersisted: () => null,
  };
}

// window/location stubs: connect() computes a ws URL from `location` and installs
// a beforeunload handler on `window`.
function stubEnv() {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
}

function makeSession(overrides: Partial<SyncSessionDeps> = {}) {
  const built: any[] = [];
  const deps: SyncSessionDeps = {
    project: freshProject(),
    wsClientFactory: () => (o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; },
    syncEnabled: () => true,
    auth: () => ({ accessToken: ref(undefined), session: ref(null) }),
    ...overrides,
  };
  const session = new SyncSession(deps);
  return { session, built };
}

describe('SyncSession', () => {
  it('constructs with no side effects and starts disconnected in the lobby', () => {
    stubEnv();
    const { session, built } = makeSession();
    expect(built).toHaveLength(0);          // constructor built no socket
    expect(session.isConnected).toBe(false);
    expect(session.currentRoomId.value).toBeNull();
    expect(session.roomLoading.value).toBe(false);
    expect(session.fatalError.value).toBeNull();
  });

  it('connect(roomId) builds+opens a socket, sets currentRoomId, raises roomLoading', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    expect(built).toHaveLength(1);
    expect(built[0]._opts.roomId).toBe('room-a');
    expect(built[0].connect).toHaveBeenCalledWith({ forceSnapshot: true });
    expect(session.isConnected).toBe(true);
    expect(session.currentRoomId.value).toBe('room-a');
    expect(session.roomLoading.value).toBe(true);
  });

  it('sync.complete flips isSyncLive true and clears roomLoading', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    expect(session.isSyncLive).toBe(false);
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    expect(session.isSyncLive).toBe(true);
    expect(session.roomLoading.value).toBe(false);
  });

  it('dispatchLocal writes state + enqueues when live; returns false when disconnected', () => {
    stubEnv();
    const { session, built } = makeSession();
    // disconnected: no bus → returns false, no throw
    expect(session.dispatchLocal({ path: ['bpm'], value: 140 })).toBe(false);
    session.connect('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 }); // go live
    expect(session.dispatchLocal({ path: ['bpm'], value: 140, priorValue: 120, gestureEnd: true })).toBe(true);
    expect(built[0].sent.some((op: any) => op.path?.[0] === 'bpm' && op.value === 140)).toBe(true);
  });

  it('enqueue is a no-op until the room is live, then reaches the outbox', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    session.enqueue(['bpm'], 130, 120, true);          // not live yet
    expect(built[0].sent).toHaveLength(0);
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    session.enqueue(['bpm'], 130, 120, true);          // live
    expect(built[0].sent.some((op: any) => op.path?.[0] === 'bpm')).toBe(true);
  });

  it('disconnect() disconnects the socket and clears state; dispose() is idempotent', () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    session.disconnect();
    expect(built[0].disconnect).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(false);
    expect(session.currentRoomId.value).toBeNull();
    expect(session.roomLoading.value).toBe(false);
    // idempotent: a second teardown does not throw and does not re-disconnect.
    session.dispose();
    expect(built[0].disconnect).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(false);
  });

  it('connect() in disabled mode sets currentRoomId without opening a socket', () => {
    stubEnv();
    const { session, built } = makeSession({ syncEnabled: () => false });
    session.connect('room-a');
    expect(built).toHaveLength(0);
    expect(session.isConnected).toBe(false);
    expect(session.currentRoomId.value).toBe('room-a');
    expect(session.roomLoading.value).toBe(false);
  });
});
