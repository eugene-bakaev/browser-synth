import { describe, it, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { setDeep } from '@fiddle/shared';
import { freshProject, replaceProject } from '../project';
import { SyncSession, type SyncSessionDeps } from './SyncSession';
import { createCommandBus } from './CommandBus';

// A fake WsClient matching the surface SyncSession/messageDispatch touch. The
// factory captures opts so the test can push server messages via opts.onMessage.
function makeFakeWsClient(opts: any) {
  let seq = 0;
  return {
    _opts: opts,
    sent: [] as any[],
    state: 'closed' as string,
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
  const project = freshProject();
  let session: SyncSession;
  const bus = createCommandBus({
    applySet: (path, value) => setDeep(project as unknown as Record<string, unknown>, path, value),
    loadProject: (next) => replaceProject(project, next),
    enqueue: (path, value, prior, ge) => session.enqueue(path, value, prior, ge),
  });
  const deps: SyncSessionDeps = {
    bus,
    wsClientFactory: () => (o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; },
    syncEnabled: () => true,
    auth: () => ({ accessToken: ref(undefined), session: ref(null), ready: Promise.resolve() }),
    ...overrides,
  };
  session = new SyncSession(deps);
  return { session, built, project, bus };
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

  it('connect(roomId) builds+opens a socket, sets currentRoomId, raises roomLoading', async () => {
    stubEnv();
    const { session, built } = makeSession();
    session.connect('room-a');
    await Promise.resolve();
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

  it('bus.dispatchLocal pre-connect writes state but sends nothing; after live it reaches the wire', () => {
    stubEnv();
    const { session, built, project, bus } = makeSession();
    bus.dispatchLocal({ path: ['bpm'], value: 140 });   // disconnected: no throw, no send
    expect(project.bpm).toBe(140);
    session.connect('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 }); // go live
    bus.dispatchLocal({ path: ['bpm'], value: 141, priorValue: 140, gestureEnd: true });
    expect(built[0].sent.some((op: any) => op.path?.[0] === 'bpm' && op.value === 141)).toBe(true);
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

  it('reconnecting to a room resets the bus watermark (an old opId applies again)', () => {
    stubEnv();
    const { session, built, project, bus } = makeSession();
    session.connect('room-a');
    bus.applyRemote({ v: 1, type: 'set', opId: 7, path: ['bpm'], value: 130, clientId: 'peer' } as never);
    session.disconnect();
    session.connect('room-b');   // buildConnection resets the watermark
    expect(bus.applyRemote({ v: 1, type: 'set', opId: 3, path: ['bpm'], value: 99, clientId: 'peer' } as never)).toBe(true);
    expect(project.bpm).toBe(99);
    expect(built).toHaveLength(2);
  });

  it('connect() opens the socket only after auth is ready (no guest hello before getSession)', async () => {
    stubEnv();
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const authSession = ref(null);
    const { session, built } = makeSession({
      auth: () => ({ accessToken: ref(undefined), session: authSession, ready }),
    });
    session.connect('room-a');
    expect(built).toHaveLength(1);                    // connection built eagerly
    expect(built[0].connect).not.toHaveBeenCalled();  // …but not opened yet
    resolveReady();
    await Promise.resolve();
    expect(built[0].connect).toHaveBeenCalledWith({ forceSnapshot: true });
  });

  it('a disconnect() while auth is resolving aborts the pending open', async () => {
    stubEnv();
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const { session, built } = makeSession({
      auth: () => ({ accessToken: ref(undefined), session: ref(null), ready }),
    });
    session.connect('room-a');
    session.disconnect();
    resolveReady();
    await Promise.resolve();
    expect(built[0].connect).not.toHaveBeenCalled();
  });

  it('an auth flip before the socket ever connected does not bounce it (boot getSession)', async () => {
    stubEnv();
    const authSession = ref<{ user: { id: string } } | null>(null);
    const { session, built } = makeSession({
      auth: () => ({ accessToken: ref(undefined), session: authSession, ready: Promise.resolve() }),
    });
    session.connect('room-a');
    built[0].state = 'closed'; // never handshaken — nothing to re-derive
    authSession.value = { user: { id: 'u1' } };
    await nextTick();
    expect(built[0].reconnect).not.toHaveBeenCalled();
  });

  it('an auth flip on a live socket reconnects (login/logout mid-session)', async () => {
    stubEnv();
    const authSession = ref<{ user: { id: string } } | null>(null);
    const { session, built } = makeSession({
      auth: () => ({ accessToken: ref(undefined), session: authSession, ready: Promise.resolve() }),
    });
    session.connect('room-a');
    await Promise.resolve();
    built[0].state = 'live';
    authSession.value = { user: { id: 'u1' } };
    await nextTick();
    expect(built[0].reconnect).toHaveBeenCalledTimes(1);
  });
});
