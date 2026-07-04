// End-to-end protocol test: boots the real Fastify server on an ephemeral port
// and drives it with actual WebSocket clients (node's global WebSocket). Unlike
// the ConnectionHandler unit tests (which call onMessage directly with mocks),
// this exercises the full wire path: HTTP upgrade → @fastify/websocket → route →
// ConnectionHandler → JSON frames back over a real socket.
//
// Excluded from the default `vitest run` (see vitest.config.ts) because it needs
// a listening socket; run via `npm run test:e2e`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { PROJECT_SCHEMA_VERSION, freshProject, SYNTH2_DESCRIPTORS, isDiscrete } from '@fiddle/shared';
import type { ServerMessage, ClientMessage } from '@fiddle/shared';
import { buildServer } from '../server.js';

let app: ReturnType<typeof buildServer>;
let port: number;

beforeAll(async () => {
  // Every test creates its session from 127.0.0.1 — lift the per-IP create
  // burst so the suite doesn't trip the M4 rate limit it isn't testing.
  process.env.SESSION_CREATE_BURST = '1000';
  app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

async function createSession(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e', clientId: 'e2e-client' }),
  });
  if (res.status !== 201) throw new Error(`createSession failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

// A small WS client wrapper that records inbound messages and lets a test await
// the first message matching a predicate (with a timeout so a hang fails loud).
function connect(roomId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${roomId}`);
  const recv: ServerMessage[] = [];
  ws.addEventListener('message', (e) => recv.push(JSON.parse(e.data as string)));
  return {
    raw: ws,
    recv,
    opened: new Promise<void>((res) => ws.addEventListener('open', () => res())),
    send: (m: ClientMessage) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    async waitFor(pred: (m: ServerMessage) => boolean, ms = 1000): Promise<ServerMessage> {
      const deadline = Date.now() + ms;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const hit = recv.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error('waitFor: timed out');
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

describe('protocol e2e', () => {
  it('fresh hello → welcome + snapshot + sync.complete', async () => {
    const room = await createSession();
    const c = connect(room);
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

    const welcome = await c.waitFor((m) => m.type === 'welcome');
    const snapshot = await c.waitFor((m) => m.type === 'snapshot');
    const done = await c.waitFor((m) => m.type === 'sync.complete');

    if (welcome.type !== 'welcome' || snapshot.type !== 'snapshot') throw new Error('unreachable');
    expect(welcome.clientId).toMatch(/^c_/);
    expect(welcome.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(welcome.roster).toHaveLength(1);
    expect(snapshot.project.bpm).toBe(120);
    expect(done.type).toBe('sync.complete');
    c.close();
  });

  it('op from one client echoes to sender and broadcasts to peer (clientSeq hidden)', async () => {
    const room = await createSession();
    const a = connect(room);
    await a.opened;
    a.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    await a.waitFor((m) => m.type === 'sync.complete');

    const b = connect(room);
    await b.opened;
    b.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    const bWelcome = await b.waitFor((m) => m.type === 'welcome');
    await b.waitFor((m) => m.type === 'sync.complete');
    if (bWelcome.type !== 'welcome') throw new Error('unreachable');
    expect(bWelcome.roster).toHaveLength(2);

    a.send({ v: 1, type: 'set', clientSeq: 7, path: ['bpm'], value: 145 });

    const echo = await a.waitFor((m) => m.type === 'set');
    const broadcast = await b.waitFor((m) => m.type === 'set');
    if (echo.type !== 'set' || broadcast.type !== 'set') throw new Error('unreachable');
    expect(echo.clientSeq).toBe(7);        // echo carries the sender's clientSeq
    expect(echo.opId).toBe(1);
    expect(echo.value).toBe(145);
    expect(broadcast.clientSeq).toBeUndefined(); // peer must not see it
    expect(broadcast.opId).toBe(echo.opId);
    expect(broadcast.value).toBe(145);

    a.close();
    b.close();
  });

  it('out-of-range index is nacked path.invalid (no crash, no broadcast)', async () => {
    const room = await createSession();
    const c = connect(room);
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    await c.waitFor((m) => m.type === 'sync.complete');

    c.send({ v: 1, type: 'set', clientSeq: 1, path: ['tracks', 99, 'engineType'], value: 'kick' });

    const nack = await c.waitFor((m) => m.type === 'nack');
    if (nack.type !== 'nack') throw new Error('unreachable');
    expect(nack.code).toBe('path.invalid');
    expect(nack.clientSeq).toBe(1);
    expect(c.recv.find((m) => m.type === 'set')).toBeUndefined();
    c.close();
  });

  // A duplicate (clientId, clientSeq) is an Outbox resend of an op whose echo
  // got lost — the server must echo its STORED op (so the client's in-flight
  // entry resolves) rather than nack or re-apply the new value. Mirrors the
  // ConnectionHandler unit test over a real socket.
  it('duplicate clientSeq is echoed with the stored op (not nacked, not re-applied)', async () => {
    const room = await createSession();
    const c = connect(room);
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    await c.waitFor((m) => m.type === 'sync.complete');

    c.send({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 130 });
    await c.waitFor((m) => m.type === 'set');

    c.send({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 131 });
    // Wait for the SECOND set frame — the duplicate echo.
    await c.waitFor(() => c.recv.filter((m) => m.type === 'set').length >= 2);
    const sets = c.recv.filter((m) => m.type === 'set');
    if (sets[0]!.type !== 'set' || sets[1]!.type !== 'set') throw new Error('unreachable');
    expect(sets[1]).toMatchObject({ clientSeq: 1, value: 130 }); // stored op, not 131
    expect(sets[1]!.opId).toBe(sets[0]!.opId); // same applied op, no re-apply
    expect(c.recv.find((m) => m.type === 'nack')).toBeUndefined();
    c.close();
  });

  // M1 regression: closing the LAST socket used to delete the guest session row
  // immediately, while the in-memory room lived on for the 5-minute grace
  // window — so a guest who refreshed rejoined a working-looking room whose
  // edits could never persist again (saveSnapshot no-ops without a row) and
  // whose settings panel 404'd. The row must survive until grace expiry.
  it('guest session row survives last-socket close and a rejoin within grace', async () => {
    const room = await createSession();
    const a = connect(room);
    await a.opened;
    a.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    const w = await a.waitFor((m) => m.type === 'welcome');
    if (w.type !== 'welcome') throw new Error('unreachable');
    a.send({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 150 });
    await a.waitFor((m) => m.type === 'set');
    a.close();

    // The close handler runs async (flush + grace arm); poll until the server
    // reports the room empty via the lobby's live count — simpler: just give
    // the disconnect path a beat, then assert the row is still there.
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${room}`);
    expect(res.status).toBe(200); // pre-fix: 404, row deleted on empty

    // Rejoin within grace: same identity resumes, and the room still works.
    const a2 = connect(room);
    await a2.opened;
    a2.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION, clientId: w.clientId, resumeFromOpId: 1 });
    const w2 = await a2.waitFor((m) => m.type === 'welcome');
    await a2.waitFor((m) => m.type === 'sync.complete');
    if (w2.type !== 'welcome') throw new Error('unreachable');
    expect(w2.clientId).toBe(w.clientId);

    // Post-rejoin edits are still accepted (and, with the row alive, can flush).
    a2.send({ v: 1, type: 'set', clientSeq: 2, path: ['bpm'], value: 152 });
    await a2.waitFor((m) => m.type === 'set' && m.value === 152);
    a2.close();
    await new Promise((r) => setTimeout(r, 100));
    const res2 = await fetch(`http://127.0.0.1:${port}/api/sessions/${room}`);
    expect(res2.status).toBe(200); // still inside grace — row intact
  });

  it('reconnect with a known clientId resumes the same identity (no unknown_client)', async () => {
    const room = await createSession();
    const a = connect(room);
    await a.opened;
    a.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    const w1 = await a.waitFor((m) => m.type === 'welcome');
    if (w1.type !== 'welcome') throw new Error('unreachable');
    const clientId = w1.clientId;
    a.send({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 130 });
    await a.waitFor((m) => m.type === 'set');
    a.close();

    // Reconnect with the same clientId + last opId — the room (and identity)
    // survive the brief gap, so the server resumes us.
    const a2 = connect(room);
    await a2.opened;
    a2.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION, clientId, resumeFromOpId: 1 });
    const w2 = await a2.waitFor((m) => m.type === 'welcome');
    await a2.waitFor((m) => m.type === 'sync.complete');
    if (w2.type !== 'welcome') throw new Error('unreachable');
    expect(w2.clientId).toBe(clientId);
    expect(a2.recv.find((m) => m.type === 'error' && m.code === 'resume.unknown_client')).toBeUndefined();
    a2.close();
  });

  it('reconnect with an unknown clientId (server lost state) issues a fresh identity + non-fatal resume.unknown_client', async () => {
    // Models the server-restart case: in-memory room state is gone, so a client
    // resuming with its old clientId is unknown — gets a new identity and a
    // non-fatal warning, then a fresh snapshot.
    const room = await createSession();
    const c = connect(room);
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION, clientId: 'c_ghost00', resumeFromOpId: 5 });
    const welcome = await c.waitFor((m) => m.type === 'welcome');
    const err = await c.waitFor((m) => m.type === 'error' && m.code === 'resume.unknown_client');
    await c.waitFor((m) => m.type === 'sync.complete');
    if (welcome.type !== 'welcome' || err.type !== 'error') throw new Error('unreachable');
    expect(welcome.clientId).not.toBe('c_ghost00');
    expect(err.fatal).toBe(false);
    c.close();
  });

  it('schema version mismatch is fatal', async () => {
    const room = await createSession();
    const c = connect(room);
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: 9999 });
    const err = await c.waitFor((m) => m.type === 'error');
    if (err.type !== 'error') throw new Error('unreachable');
    expect(err.code).toBe('schema.version_mismatch');
    expect(err.fatal).toBe(true);
    c.close();
  });

  it('rejects a hello for a session that was never created', async () => {
    const c = connect('never-created-x');
    await c.opened;
    c.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    const err = await c.waitFor((m) => m.type === 'error');
    if (err.type !== 'error') throw new Error('unreachable');
    expect(err.code).toBe('session.not_found');
    expect(err.fatal).toBe(true);
    c.close();
  });

  // Regression for the rate-limit data-loss bug: importing a big project used
  // to be sent as hundreds of individual `set` ops, which blew through the
  // per-connection TokenBucket and silently dropped random leaves (nacked ops
  // the client's Outbox then rolled back). A `load` message replaces the whole
  // doc atomically in one frame, so it can't be partially rate-limited.
  it('bulk load: a large project replaces the room losslessly for both clients', async () => {
    const room = await createSession();

    const a = connect(room);
    await a.opened;
    a.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    await a.waitFor((m) => m.type === 'sync.complete');

    const b = connect(room);
    await b.opened;
    b.send({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    await b.waitFor((m) => m.type === 'sync.complete');

    // Build a big project: 8 enabled synth2 tracks, each with ~41 distinct
    // continuous leaves set away from their defaults — 328 changed synth2
    // leaves alone, comfortably past the 266-op burst that used to trip the
    // rate limiter.
    const big = freshProject();
    big.bpm = 63;
    let changedLeaves = 1; // bpm
    for (let i = 0; i < 8; i++) {
      const track = big.tracks[i]!;
      track.enabled = true;
      track.engineType = 'synth2';
      changedLeaves += 2; // enabled + engineType
      for (const d of SYNTH2_DESCRIPTORS) {
        if (isDiscrete(d)) continue; // bool/enum fields aren't continuous
        const [mod, field] = d.key.split('.') as [string, string];
        (track.engines.synth2 as unknown as Record<string, Record<string, number>>)[mod]![field] =
          (d.min + d.max) / 2;
        changedLeaves += 1;
      }
    }
    expect(changedLeaves).toBeGreaterThan(266);

    a.send({ v: 1, type: 'load', clientSeq: 1, project: big });

    // Both clients converge on a snapshot carrying the new bpm (not the
    // hello-phase fresh-project snapshot, which is still bpm 120).
    const snapA = await a.waitFor((m) => m.type === 'snapshot' && m.project.bpm === 63);
    const snapB = await b.waitFor((m) => m.type === 'snapshot' && m.project.bpm === 63);
    if (snapA.type !== 'snapshot' || snapB.type !== 'snapshot') throw new Error('unreachable');

    expect(snapA.project.bpm).toBe(63);
    expect(snapB.project.bpm).toBe(63);
    for (let i = 0; i < 8; i++) {
      expect(snapA.project.tracks[i]!.engineType).toBe('synth2');
      expect(snapA.project.tracks[i]!.enabled).toBe(true);
      expect(snapA.project.tracks[i]!.engines.synth2).toEqual(big.tracks[i]!.engines.synth2);
      expect(snapB.project.tracks[i]!.engines.synth2).toEqual(big.tracks[i]!.engines.synth2);
    }

    // No nack of any kind reached the originator.
    expect(a.recv.find((m) => m.type === 'nack')).toBeUndefined();

    // Sequence continues past the load: a normal set op lands at opId + 1.
    b.send({ v: 1, type: 'set', clientSeq: 1, path: ['bpm'], value: 140 });
    const setA = await a.waitFor((m) => m.type === 'set');
    const setB = await b.waitFor((m) => m.type === 'set');
    if (setA.type !== 'set' || setB.type !== 'set') throw new Error('unreachable');
    expect(setA.opId).toBe(snapA.opId + 1);
    expect(setB.opId).toBe(snapA.opId + 1);

    a.close();
    b.close();
  });
});
