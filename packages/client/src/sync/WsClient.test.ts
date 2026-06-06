import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WsClient } from './WsClient';
import { PROJECT_SCHEMA_VERSION, type ServerMessage } from '@fiddle/shared';

// Minimal WebSocket double. The real WebSocket constructor type is
// `typeof WebSocket`, which is just a structural constructor signature —
// passing this as `socketCtor` via `as unknown as typeof WebSocket` works
// because none of the static surface is consulted at runtime.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  _open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  _msg(data: string) {
    this.onmessage?.({ data });
  }
}

// In-memory `Storage` substitute. sessionStorage is jsdom-only and we want
// these tests to run in Node without an env pragma.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
}

function makeClient(opts?: {
  storage?: Storage;
  onMessage?: (m: ServerMessage) => void;
  onStateChange?: (s: string) => void;
  roomId?: string;
  getToken?: () => string | undefined;
}) {
  const storage = opts?.storage ?? memoryStorage();
  const client = new WsClient({
    url: 'ws://test/ws/room',
    roomId: opts?.roomId ?? 'room',
    socketCtor: MockWebSocket as unknown as typeof WebSocket,
    storage,
    onMessage: opts?.onMessage ?? (() => {}),
    onStateChange: opts?.onStateChange,
    getToken: opts?.getToken,
  });
  return { client, storage };
}

// Drive a client to the 'live' state: open, welcome, sync.complete.
function driveLive(client: WsClient, sock: MockWebSocket) {
  sock._open();
  sock._msg(
    JSON.stringify({
      v: 1,
      type: 'welcome',
      clientId: 'c_1',
      color: '#fff',
      handle: 'kangaroo',
      opIdHead: 0,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      roster: [],
    }),
  );
  sock._msg(JSON.stringify({ v: 1, type: 'sync.complete', opId: 0 }));
}

describe('WsClient', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  it('sends a fresh hello on open when no clientId is persisted', () => {
    const { client } = makeClient();
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    expect(sock.sent).toHaveLength(1);
    const hello = JSON.parse(sock.sent[0]);
    expect(hello).toEqual({
      v: 1,
      type: 'hello',
      schemaVersion: PROJECT_SCHEMA_VERSION,
    });
    expect(hello.clientId).toBeUndefined();
    expect(hello.resumeFromOpId).toBeUndefined();
  });

  it('sends a resume hello when clientId + opIdLastSeen are persisted', () => {
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_old', opIdLastSeen: 42, clientSeq: 7 }),
    );
    const { client } = makeClient({ storage });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    const hello = JSON.parse(sock.sent[0]);
    expect(hello).toEqual({
      v: 1,
      type: 'hello',
      schemaVersion: PROJECT_SCHEMA_VERSION,
      clientId: 'c_old',
      resumeFromOpId: 42,
    });
  });

  it('keeps clientId but omits resumeFromOpId on connect({ forceSnapshot: true })', () => {
    // A deliberate (re)entry resets local project state, so a resume delta would
    // leave the room blank — forceSnapshot must pull a full snapshot while still
    // preserving guest identity/ownership (clientId).
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_old', opIdLastSeen: 42, clientSeq: 7 }),
    );
    const { client } = makeClient({ storage });
    client.connect({ forceSnapshot: true });
    const sock = MockWebSocket.instances[0];
    sock._open();
    const hello = JSON.parse(sock.sent[0]);
    expect(hello).toEqual({
      v: 1,
      type: 'hello',
      schemaVersion: PROJECT_SCHEMA_VERSION,
      clientId: 'c_old',
    });
    expect('resumeFromOpId' in hello).toBe(false);
  });

  it('resumes (does not force snapshot) on a plain auto-reconnect connect()', () => {
    // The forceSnapshot flag is per-connect; an auto-reconnect calls connect()
    // with no args and must keep resuming so transient blips don't re-snapshot.
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_old', opIdLastSeen: 42, clientSeq: 7 }),
    );
    const { client } = makeClient({ storage });
    client.connect({ forceSnapshot: true });
    client.disconnect();
    client.connect();
    const sock = MockWebSocket.instances.at(-1)!;
    sock._open();
    const hello = JSON.parse(sock.sent[0]);
    expect(hello.resumeFromOpId).toBe(42);
  });

  it('transitions to live on sync.complete', () => {
    const { client } = makeClient();
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    sock._msg(
      JSON.stringify({
        v: 1,
        type: 'welcome',
        clientId: 'c_new',
        color: '#ff0000',
        handle: 'Nova',
        opIdHead: 0,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        roster: [],
      }),
    );
    expect(client.state).toBe('catching-up');
    sock._msg(JSON.stringify({ v: 1, type: 'sync.complete', opId: 0 }));
    expect(client.state).toBe('live');
    expect(client.isLive()).toBe(true);
  });

  it('persists clientId + opIdHead on welcome (resets clientSeq for new identity)', () => {
    const { client, storage } = makeClient();
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    sock._msg(
      JSON.stringify({
        v: 1,
        type: 'welcome',
        clientId: 'c_new',
        color: '#ff0000',
        handle: 'Nova',
        opIdHead: 100,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        roster: [],
      }),
    );
    const raw = storage.getItem('fiddle:sync:room');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      clientId: 'c_new',
      opIdLastSeen: 100,
      clientSeq: 0,
    });
  });

  it('auto-responds to ping with pong', () => {
    const onMessage = vi.fn();
    const { client } = makeClient({ onMessage });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    // Clear the hello so we only see the pong below.
    sock.sent.length = 0;
    sock._msg(JSON.stringify({ v: 1, type: 'ping' }));
    expect(sock.sent).toHaveLength(1);
    expect(JSON.parse(sock.sent[0])).toEqual({ v: 1, type: 'pong' });
    // onMessage is still invoked after the auto-pong.
    expect(onMessage).toHaveBeenCalledWith({ v: 1, type: 'ping' });
  });

  it('nextClientSeq increments monotonically and persists', () => {
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_x', opIdLastSeen: 0, clientSeq: 0 }),
    );
    const { client } = makeClient({ storage });
    expect(client.nextClientSeq()).toBe(1);
    expect(client.nextClientSeq()).toBe(2);
    expect(client.nextClientSeq()).toBe(3);
    const persisted = JSON.parse(storage.getItem('fiddle:sync:room')!);
    expect(persisted.clientSeq).toBe(3);
  });

  it('includes the token from getToken in the hello frame', () => {
    const { client } = makeClient({ getToken: () => 'tok-abc' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    const hello = JSON.parse(sock.sent[0]);
    expect(hello.token).toBe('tok-abc');
  });

  it('omits token when getToken returns undefined (guest)', () => {
    const { client } = makeClient({ getToken: () => undefined });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    const hello = JSON.parse(sock.sent[0]);
    expect(hello.token).toBeUndefined();
    expect('token' in hello).toBe(false);
  });

  it('reconnect() closes and reopens, re-sending hello', () => {
    const { client } = makeClient({ getToken: () => 'tok-1' });
    client.connect();
    const first = MockWebSocket.instances[0];
    driveLive(client, first);
    expect(client.isLive()).toBe(true);

    client.reconnect();
    // Old socket was closed.
    expect(first.readyState).toBe(3);
    // A fresh socket was opened.
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1];
    second._open();
    const hello = JSON.parse(second.sent[0]);
    expect(hello.type).toBe('hello');
    expect(hello.token).toBe('tok-1');
  });

  it('a superseded socket opening late does not send hello on the new (still-connecting) socket', () => {
    // Repro of the prod console error: "Failed to execute 'send' on 'WebSocket':
    // Still in CONNECTING state" thrown from onopen→sendHello. A reconnect swaps
    // this.socket to a new, still-connecting socket; the OLD socket then fires
    // onopen and (pre-fix) calls sendHello against the new connecting socket.
    const { client } = makeClient();
    client.connect();
    const first = MockWebSocket.instances[0];

    client.reconnect();
    const second = MockWebSocket.instances[1];
    expect(second.readyState).toBe(0); // still CONNECTING

    // The stale first socket opens late. Its handler must be ignored.
    first._open();

    // The new connecting socket must NOT have received a hello from the stale open.
    expect(second.sent).toEqual([]);
  });

  it('a superseded socket closing does not trigger a reconnect against the live socket', () => {
    const { client } = makeClient();
    client.connect();
    const first = MockWebSocket.instances[0];
    client.reconnect();
    const second = MockWebSocket.instances[1];
    driveLive(client, second);
    expect(client.isLive()).toBe(true);

    // Stale socket fires a late close; it must not disturb the live connection.
    first.onclose?.({});
    expect(client.isLive()).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(2); // no spurious reconnect socket
  });
});
