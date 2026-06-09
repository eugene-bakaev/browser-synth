# Guaranteed Local Delivery & Non-Destructive Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every local edit reaches the in-memory authoritative room (at-least-once) and that a server snapshot can never erase an un-acked local edit, while peers self-repair missed broadcasts — with **no new DB writes**.

**Architecture:** Four independent pieces over the existing leaf-`set` op protocol: (1) at-least-once Outbox with ack-timeout resend + duplicate-as-success; (2) non-destructive reconcile-merge on snapshot; (3) opId-gap detection + mid-session `resync` replay; (4) version-gated periodic flush. The server stays the sole orderer; multi-user same-leaf conflicts resolve by server arrival order.

**Tech Stack:** TypeScript, Vue 3 reactivity, Vitest, npm workspaces (`@fiddle/client`, `@fiddle/server`, `@fiddle/shared`), Zod (client→server schemas), WebSocket.

**Spec:** `docs/superpowers/specs/2026-06-07-guaranteed-local-delivery-design.md`

**Gate (run before every commit):** `npm run typecheck && npm test && npm run build`

**Per-package test command:** `npm test -w @fiddle/<pkg> -- <relative-path> -t "<test name>"` (note: do **not** pass `-w` to vitest directly — `-w` is the npm workspace flag; vitest treats `-w` as watch mode and hangs).

---

## Implementation order & dependencies

```
Piece 1 (delivery):  Task 1 → Task 2 (server dup-echo) ; Task 3 → Task 4 → Task 5 (Outbox)
Piece 2 (reconcile): Task 6 (depends on Task 5)
Piece 1 (leave):     Task 7
Piece 3 (peer):      Task 8 (shared) → Task 9 (server) ; Task 10 (client, depends on Task 8)
Piece 4 (persist):   Task 11
```

Each task ends green and committed. Tasks 1–7 are the core two guarantees; 8–10 add peer-repair; 11 closes the durable lost-update window.

---

## Task 1: Server — duplicate `appendOp` returns the existing op

**Why:** Idempotent resend (Task 3) needs the server to recognise a re-sent op and confirm it. Today `appendOp` returns `{ ok: false, reason: 'duplicate' }` with no reference to the already-applied op, so the handler can't echo it. This task makes the duplicate result carry the original `AppliedOp`.

**Files:**
- Modify: `packages/server/src/room/RoomStore.ts:29-31` (the `AppendOpResult` type)
- Modify: `packages/server/src/room/InMemoryRoomStore.ts:40-48` (the dedupe scan)
- Test: `packages/server/src/room/InMemoryRoomStore.test.ts` (create if absent; otherwise add a `describe`)

- [ ] **Step 1: Write the failing test**

In `packages/server/src/room/InMemoryRoomStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryRoomStore } from './InMemoryRoomStore.js';
import { freshProject } from '@fiddle/shared';

describe('InMemoryRoomStore.appendOp dedupe', () => {
  it('returns the original op when the same (clientId, clientSeq) is re-appended', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r', freshProject);

    const first = await store.appendOp('r', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 130 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    const dup = await store.appendOp('r', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 130 });
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error('unreachable');
    expect(dup.reason).toBe('duplicate');
    expect(dup.op).toEqual(first.op); // carries the already-applied op
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -w @fiddle/server -- src/room/InMemoryRoomStore.test.ts -t "returns the original op"`
Expected: FAIL — `dup.op` is `undefined` (and a TS error that `op` doesn't exist on the duplicate variant).

- [ ] **Step 3: Extend the type**

In `packages/server/src/room/RoomStore.ts`, replace the `AppendOpResult` type:

```ts
export type AppendOpResult =
  | { ok: true; op: AppliedOp }
  | { ok: false; reason: 'duplicate'; op: AppliedOp };
```

- [ ] **Step 4: Return the original op on a duplicate**

In `packages/server/src/room/InMemoryRoomStore.ts`, change the dedupe scan (lines 44-48):

```ts
    for (const entry of room.opLog) {
      if (entry.clientId === input.clientId && entry.clientSeq === input.clientSeq) {
        return { ok: false, reason: 'duplicate', op: entry };
      }
    }
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -w @fiddle/server -- src/room/InMemoryRoomStore.test.ts -t "returns the original op"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/room/RoomStore.ts packages/server/src/room/InMemoryRoomStore.ts packages/server/src/room/InMemoryRoomStore.test.ts
git commit -m "feat(server): appendOp duplicate result carries the existing op

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Server — echo on duplicate instead of nacking

**Why:** A resend of an op the server already applied (lost echo) must be confirmed, not rejected. Today it nacks `op.duplicate`, which the client rolls back. After this task a duplicate produces a normal echo `set` carrying the original `opId` + the incoming `clientSeq`, so the client's `onEcho` clears it with no rollback.

**Files:**
- Modify: `packages/server/src/sync/ConnectionHandler.ts:154-177` (the `set` handler)
- Modify: `packages/server/src/sync/ConnectionHandler.test.ts` (add a test)

- [ ] **Step 1: Write the failing test**

In `packages/server/src/sync/ConnectionHandler.test.ts`, add inside the top-level `describe('ConnectionHandler', ...)`:

```ts
it('a duplicate set is echoed (not nacked) to the originator', async () => {
  const socket = makeMockSocket();
  const pool = new FakePool();
  pool.add('room1', socket);
  const handler = new ConnectionHandler('room1', socket, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
  await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

  const setMsg = { v: 1 as const, type: 'set' as const, clientSeq: 1, path: ['bpm'], value: 130 };
  await handler.onMessage(setMsg);
  await handler.onMessage(setMsg); // resend of the same clientSeq

  const sets = socket.sent.filter((m) => m.type === 'set');
  expect(sets).toHaveLength(2); // first apply + a duplicate echo (NOT a nack)
  expect(socket.sent.some((m) => m.type === 'nack')).toBe(false);
  // Both echoes carry the same opId and the originator's clientSeq.
  const [a, b] = sets;
  if (a.type !== 'set' || b.type !== 'set') throw new Error('unreachable');
  expect(b.opId).toBe(a.opId);
  expect(b.clientSeq).toBe(1);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -w @fiddle/server -- src/sync/ConnectionHandler.test.ts -t "duplicate set is echoed"`
Expected: FAIL — a `nack` is sent and only one `set` appears.

- [ ] **Step 3: Echo the duplicate**

In `packages/server/src/sync/ConnectionHandler.ts`, replace the duplicate branch (lines 160-163):

```ts
      if (!r.ok) {
        // Duplicate (clientId, clientSeq): the op is already applied — confirm it
        // by echoing the existing op back to the originator instead of nacking
        // (a nack would make the client roll back a change the server actually
        // has). Idempotent resends therefore resolve transparently.
        const echo: SetOpBroadcast = {
          v: 1,
          type: 'set',
          opId: r.op.opId,
          clientId: this.clientId,
          clientSeq: msg.clientSeq,
          path: r.op.path,
          value: r.op.value,
        };
        this.socket.send(echo);
        return;
      }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -w @fiddle/server -- src/sync/ConnectionHandler.test.ts -t "duplicate set is echoed"`
Expected: PASS.

- [ ] **Step 5: Run the whole ConnectionHandler suite (no regression)**

Run: `npm test -w @fiddle/server -- src/sync/ConnectionHandler.test.ts`
Expected: PASS. If a pre-existing test asserted an `op.duplicate` nack, update it to expect the echo (the nack path for duplicates is intentionally gone; `op.duplicate` remains a valid `NackCode` type for now but is no longer emitted).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/sync/ConnectionHandler.ts packages/server/src/sync/ConnectionHandler.test.ts
git commit -m "feat(server): echo duplicate ops instead of nacking them

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Client Outbox — ack-timeout resend

**Why:** An op sent but never echoed/nacked (dropped frame, lost echo) sits in `inFlight` forever. Add a per-op deadline that resends the same `clientSeq` (safe now that the server echoes duplicates) up to a cap.

**Files:**
- Modify: `packages/client/src/sync/Outbox.ts` (PendingEntry, constants, `flushEntry`, `onEcho`, `onNack`, new `onAckTimeout`)
- Test: `packages/client/src/sync/Outbox.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/sync/Outbox.test.ts`, add inside `describe('Outbox', ...)`:

```ts
it('resends an un-echoed op after the ack timeout, same clientSeq', () => {
  const h = harness();
  h.outbox.enqueue(['bpm'], 130, 120, true);
  expect(h.sent.length).toBe(1);
  const cs = h.sent[0].clientSeq;
  vi.advanceTimersByTime(4000); // ACK_TIMEOUT_MS
  expect(h.sent.length).toBe(2);
  expect(h.sent[1].clientSeq).toBe(cs); // same seq → server dedupe recognises it
});

it('onEcho cancels the resend timer', () => {
  const h = harness();
  h.outbox.enqueue(['bpm'], 130, 120, true);
  h.outbox.onEcho(h.sent[0].clientSeq!);
  vi.advanceTimersByTime(4000);
  expect(h.sent.length).toBe(1); // no resend
});

it('stops resending after the cap', () => {
  const h = harness();
  h.outbox.enqueue(['bpm'], 130, 120, true);
  for (let i = 0; i < 10; i++) vi.advanceTimersByTime(4000);
  expect(h.sent.length).toBe(1 + 3); // initial + MAX_RESENDS
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts -t "resend"`
Expected: FAIL — no resend happens (`h.sent.length` stays 1).

- [ ] **Step 3: Implement resend**

In `packages/client/src/sync/Outbox.ts`:

Add the constants near `THROTTLE_MS` (line 34):

```ts
const ACK_TIMEOUT_MS = 4000;
const MAX_RESENDS = 3;
```

Extend `PendingEntry` (lines 24-32) with two fields:

```ts
interface PendingEntry {
  path: Path;
  value: unknown;
  priorValue: unknown;
  clientSeq: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  sent: boolean;
  resends: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
}
```

Add `resends: 0, ackTimer: null` to **every** `PendingEntry` literal in the file (the two in `enqueue` at lines 64-68 and 76-80, and the `onClosed` one at line 132).

Replace `onEcho` (lines 107-110) and `onNack` (lines 112-118):

```ts
  /** Server confirmed our op (echo, including a duplicate echo). Drop tracking. */
  onEcho(clientSeq: number): void {
    const entry = this.inFlight.get(clientSeq);
    if (entry?.ackTimer) clearTimeout(entry.ackTimer);
    this.inFlight.delete(clientSeq);
  }

  /** Server rejected our op (validation / rate limit). Roll back local state. */
  onNack(clientSeq: number, _code: string): void {
    const entry = this.inFlight.get(clientSeq);
    if (!entry) return; // unknown clientSeq (e.g. server restarted); ignore
    if (entry.ackTimer) clearTimeout(entry.ackTimer);
    this.inFlight.delete(clientSeq);
    this.deps.applyLocal(entry.path, entry.priorValue);
  }
```

Replace `flushEntry` (lines 137-152) to arm the ack timer:

```ts
  private flushEntry(key: string, entry: PendingEntry): void {
    this.pending.delete(key);
    if (!this.deps.isLive()) {
      this.offlineQueue.set(key, { ...entry, timer: null, ackTimer: null });
      return;
    }
    const clientSeq = this.deps.nextClientSeq();
    entry.clientSeq = clientSeq;
    entry.sent = true;
    entry.resends = 0;
    this.inFlight.set(clientSeq, entry);
    const op: SetOpClient = {
      v: 1, type: 'set', clientSeq,
      path: entry.path, value: entry.value,
    };
    this.deps.send(op);
    entry.ackTimer = setTimeout(() => this.onAckTimeout(clientSeq), ACK_TIMEOUT_MS);
  }

  // Resend an op that was never echoed/nacked within ACK_TIMEOUT_MS. Same
  // clientSeq so the server's (clientId, clientSeq) dedupe recognises it and
  // echoes rather than re-applying. Caps at MAX_RESENDS; after that the entry
  // stays tracked (a later echo still resolves it; a disconnect requeues it).
  private onAckTimeout(clientSeq: number): void {
    const entry = this.inFlight.get(clientSeq);
    if (!entry) return;            // already echoed / nacked
    entry.ackTimer = null;
    if (!this.deps.isLive()) return;          // offline: onClosed will requeue it
    if (entry.resends >= MAX_RESENDS) return; // give up resending; keep tracked
    entry.resends += 1;
    const op: SetOpClient = {
      v: 1, type: 'set', clientSeq,
      path: entry.path, value: entry.value,
    };
    this.deps.send(op);
    entry.ackTimer = setTimeout(() => this.onAckTimeout(clientSeq), ACK_TIMEOUT_MS);
  }
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts`
Expected: PASS (new tests + the existing 9).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/Outbox.ts packages/client/src/sync/Outbox.test.ts
git commit -m "feat(client): Outbox resends un-acked ops on a deadline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Client Outbox — preserve in-flight ops across disconnect

**Why:** `onClosed` moves `pending` → `offlineQueue` but drops `inFlight`. An op sent-but-not-echoed when the socket drops is silently lost on reconnect (`onLive` only flushes `offlineQueue`). Move `inFlight` into the offline queue too.

**Files:**
- Modify: `packages/client/src/sync/Outbox.ts:128-135` (`onClosed`)
- Test: `packages/client/src/sync/Outbox.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/client/src/sync/Outbox.test.ts`, add:

```ts
it('re-sends an un-echoed in-flight op after disconnect → reconnect', () => {
  const h = harness();
  h.outbox.enqueue(['bpm'], 130, 120, true); // sent, now in-flight (never echoed)
  expect(h.sent.length).toBe(1);
  h.live.current = false;
  h.outbox.onClosed();      // socket dropped before the echo
  h.live.current = true;
  h.outbox.onLive();        // reconnected
  expect(h.sent.length).toBe(2);
  expect(h.sent[1].path).toEqual(['bpm']);
  expect(h.sent[1].value).toBe(130);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts -t "in-flight op after disconnect"`
Expected: FAIL — `h.sent.length` stays 1 (the in-flight op was dropped).

- [ ] **Step 3: Implement**

In `packages/client/src/sync/Outbox.ts`, replace `onClosed` (lines 128-135):

```ts
  /** WS live → closed. Move pending AND in-flight into the offline queue so a
   *  disconnect can't strand an op that was sent but never echoed. Coalesced by
   *  path; pending (newer) wins over in-flight (older); the earliest priorValue
   *  is preserved for rollback. */
  onClosed(): void {
    const requeue = (entry: PendingEntry) => {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.ackTimer) clearTimeout(entry.ackTimer);
      const key = pathKey(entry.path);
      const existing = this.offlineQueue.get(key);
      this.offlineQueue.set(key, {
        path: entry.path,
        value: entry.value,
        priorValue: existing?.priorValue ?? entry.priorValue,
        clientSeq: null, timer: null, sent: false, resends: 0, ackTimer: null,
      });
    };
    for (const entry of this.inFlight.values()) requeue(entry);
    this.inFlight.clear();
    for (const entry of this.pending.values()) requeue(entry);
    this.pending.clear();
  }
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/Outbox.ts packages/client/src/sync/Outbox.test.ts
git commit -m "fix(client): preserve in-flight ops across disconnect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Client Outbox — `reassertPending()`

**Why:** Piece 2 needs an Outbox entrypoint that re-applies every un-acked edit on top of a just-applied snapshot and re-routes it for delivery (send if live, queue if offline) — so a server snapshot can never erase a pending local change.

**Files:**
- Modify: `packages/client/src/sync/Outbox.ts` (new `reassertPending` method)
- Test: `packages/client/src/sync/Outbox.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/sync/Outbox.test.ts`, add:

```ts
it('reassertPending re-applies an in-flight edit locally and re-sends it (live)', () => {
  const h = harness();
  h.outbox.enqueue(['bpm'], 130, 120, true); // in-flight, un-echoed
  h.sent.length = 0;
  h.applied.length = 0;
  h.outbox.reassertPending();
  expect(h.applied).toEqual([{ path: ['bpm'], value: 130 }]); // restored on top of snapshot
  expect(h.sent.length).toBe(1);
  expect(h.sent[0].value).toBe(130);                          // re-sent for delivery
});

it('reassertPending queues edits when offline', () => {
  const h = harness(false);
  h.outbox.enqueue(['bpm'], 130, 120, true); // offline → queued
  h.applied.length = 0;
  h.outbox.reassertPending();
  expect(h.applied).toEqual([{ path: ['bpm'], value: 130 }]);
  expect(h.sent.length).toBe(0);   // still offline
  h.live.current = true;
  h.outbox.onLive();
  expect(h.sent.length).toBe(1);   // flushed on reconnect
  expect(h.sent[0].value).toBe(130);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts -t "reassertPending"`
Expected: FAIL — `reassertPending` is not a function.

- [ ] **Step 3: Implement**

In `packages/client/src/sync/Outbox.ts`, add this method (e.g. after `onLive`):

```ts
  // Re-apply every un-acked local edit on top of a just-replaced project (server
  // snapshot) and re-route it for delivery. Used by the reconcile-merge so a
  // snapshot can never erase a pending change. Works whether the snapshot arrived
  // via reconnect (offline → entries re-queue) or mid-session (live → resend).
  // Coalesces all tiers by path, newest wins (offlineQueue < inFlight < pending).
  reassertPending(): void {
    const merged = new Map<string, PendingEntry>();
    const absorb = (entries: Iterable<PendingEntry>) => {
      for (const e of entries) {
        if (e.timer) clearTimeout(e.timer);
        if (e.ackTimer) clearTimeout(e.ackTimer);
        merged.set(pathKey(e.path), e);
      }
    };
    absorb(this.offlineQueue.values());
    absorb(this.inFlight.values());
    absorb(this.pending.values());
    this.offlineQueue.clear();
    this.inFlight.clear();
    this.pending.clear();

    for (const [key, e] of merged) {
      this.deps.applyLocal(e.path, e.value); // restore the edit on top of the snapshot
      this.flushEntry(key, {
        path: e.path, value: e.value, priorValue: e.priorValue,
        clientSeq: null, timer: null, sent: false, resends: 0, ackTimer: null,
      });
    }
  }
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/Outbox.ts packages/client/src/sync/Outbox.test.ts
git commit -m "feat(client): Outbox.reassertPending re-applies un-acked edits

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Client — non-destructive reconcile on snapshot

**Why:** Today `snapshot` → `replaceProject` overwrites the whole reactive project, ignoring the Outbox. Call `reassertPending()` right after so un-acked local edits survive a server repair.

**Files:**
- Modify: `packages/client/src/sync/messageDispatch.ts:42-55` (the `snapshot` case)
- Modify: `packages/client/src/sync/messageDispatch.ts:23-34` (the `DispatchDeps.outbox` is already `Outbox`; no type change needed)
- Test: `packages/client/src/sync/messageDispatch.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/client/src/sync/messageDispatch.test.ts`, update the `deps` helper's outbox mock to include `reassertPending`, then add a test:

```ts
// in deps(): outbox: { onLive: vi.fn(), onEcho: vi.fn(), onNack: vi.fn(), reassertPending: vi.fn() } as unknown as DispatchDeps['outbox'],

it('re-asserts pending edits after applying a snapshot', () => {
  const project = freshProject();
  const d = deps(project);
  dispatchServerMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() }, d);
  expect(d.outbox.reassertPending).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -w @fiddle/client -- src/sync/messageDispatch.test.ts -t "re-asserts pending"`
Expected: FAIL — `reassertPending` not called.

- [ ] **Step 3: Implement**

In `packages/client/src/sync/messageDispatch.ts`, replace the `snapshot` case (lines 42-55):

```ts
    case 'snapshot':
      // Programmatic bulk write — suppress so the sync watchers don't treat the
      // incoming snapshot as a flurry of local edits and echo it all back out.
      enterSuppress();
      try {
        // Normalize first so a snapshot from an older (pre-pool) server can't
        // under-fill the fixed 32-slot model the client assumes, or leave a
        // blank/out-of-range bpm in the reactive state.
        replaceProject(deps.project, normalizeProject(msg.project));
      } finally {
        exitSuppress();
      }
      resetApplyOpState();
      // Non-destructive reconcile: the snapshot just overwrote local state. Re-apply
      // any un-acked local edits on top and re-queue them for delivery so a server
      // repair (mid-session resync or reconnect eviction) can never erase a pending
      // change.
      deps.outbox.reassertPending();
      return;
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npm test -w @fiddle/client -- src/sync/messageDispatch.test.ts`
Expected: PASS (new test + existing snapshot-normalization test).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/messageDispatch.ts packages/client/src/sync/messageDispatch.test.ts
git commit -m "feat(client): non-destructive reconcile-merge on snapshot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Client — leave-flush on teardown and tab-close

**Why:** On leave / room-switch / tab-close, throttled `pending` edits (the ~50ms window) must be delivered before the socket closes. Add `Outbox.flushAllPending()` and call it before teardown plus on `beforeunload`.

**Files:**
- Modify: `packages/client/src/sync/Outbox.ts` (new `flushAllPending`)
- Modify: `packages/client/src/composables/useSynth.ts:396-410` (`teardownConnection`), and `buildSyncState` (~line 246-261) for the `beforeunload` hook
- Test: `packages/client/src/sync/Outbox.test.ts` and `packages/client/src/composables/useSynth.test.ts`

- [ ] **Step 1: Write the failing Outbox test**

In `packages/client/src/sync/Outbox.test.ts`, add:

```ts
it('flushAllPending sends throttled entries immediately', () => {
  const h = harness();
  h.outbox.enqueue(['bpm'], 144, 120, false); // throttled, not yet sent
  expect(h.sent.length).toBe(0);
  h.outbox.flushAllPending();
  expect(h.sent.length).toBe(1);
  expect(h.sent[0].value).toBe(144);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts -t "flushAllPending"`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement `flushAllPending`**

In `packages/client/src/sync/Outbox.ts`, add (e.g. after `flushPath`):

```ts
  /** Flush every throttled pending entry immediately (gesture-end semantics).
   *  Called on leave / tab-close so a closing socket still delivers the last
   *  edits. flushEntry routes to the offline queue if the socket is already
   *  closed, so this never throws. */
  flushAllPending(): void {
    for (const [key, entry] of [...this.pending]) {
      if (entry.timer) clearTimeout(entry.timer);
      this.flushEntry(key, entry);
    }
  }
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -w @fiddle/client -- src/sync/Outbox.test.ts -t "flushAllPending"`
Expected: PASS.

- [ ] **Step 5: Write the failing useSynth test**

In `packages/client/src/composables/useSynth.test.ts`, inside the `session-scoped connection` describe block, add:

```ts
it('leaveSession flushes throttled pending edits before the socket closes', async () => {
  const { fake, synth, mod } = await bootWithFakeSocket();
  // A continuous field (volume) rides the 50ms throttle — it is pending, not sent.
  synth.project.tracks[1].mixer.volume = 0.42;
  fake.sent.length = 0;
  mod.leaveSession();
  expect(fake.sent.some((o: any) =>
    JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']) && o.value === 0.42,
  )).toBe(true);
});
```

`bootWithFakeSocket()` returns `{ mod, synth, fake }` (see the harness at `useSynth.test.ts:158-176`); `mod.leaveSession` is the module export. The fake ws client reports `isLive: () => true`, so `flushAllPending` actually sends.

- [ ] **Step 6: Run it, verify it fails**

Run: `npm test -w @fiddle/client -- src/composables/useSynth.test.ts -t "leaveSession flushes"`
Expected: FAIL — the volume op is not sent (teardown drops it).

- [ ] **Step 7: Wire the flush into teardown + beforeunload**

In `packages/client/src/composables/useSynth.ts`, make `teardownConnection` flush first (line 396):

```ts
function teardownConnection(): void {
  // Deliver any throttled pending edits to the (still-live) socket before we
  // close it, so leaving a room / switching rooms can't strand the last edits.
  outbox?.flushAllPending();
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
  outbox = null;
  disposeSyncWatchers();
  fatalError.value = null;
  roomLoading.value = false;
  currentRoomId.value = null;
  resetPresence();
}
```

Add a module-scoped idempotent `beforeunload` installer and call it from `buildSyncState`. Near the other module-scope flags (e.g. by `authWatcherInstalled`), add:

```ts
let leaveFlushInstalled = false;
function installLeaveFlushHandler(): void {
  if (leaveFlushInstalled) return;
  if (typeof window === 'undefined') return;
  leaveFlushInstalled = true;
  window.addEventListener('beforeunload', () => {
    // Best-effort: the socket is usually still open during beforeunload, so a
    // synchronous flush gets the last throttled edits onto the wire.
    outbox?.flushAllPending();
  });
}
```

Call it inside `buildSyncState`, right after the `outbox = new Outbox({...})` block (after line 260):

```ts
  installLeaveFlushHandler();
```

- [ ] **Step 8: Run the tests, verify they pass**

Run: `npm test -w @fiddle/client -- src/composables/useSynth.test.ts -t "leaveSession flushes"` then `npm test -w @fiddle/client -- src/sync/Outbox.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/sync/Outbox.ts packages/client/src/sync/Outbox.test.ts packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): flush throttled edits on leave and tab-close

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Shared — `resync` client message type + schema

**Why:** Peer-drift repair (Task 9/10) needs a mid-session client→server request to replay missed ops. Add the message type and its Zod schema.

**Files:**
- Modify: `packages/shared/src/protocol/types.ts:31-53` (add `ResyncMessage`, extend `ClientMessage`)
- Modify: `packages/shared/src/protocol/schema.ts` (add `ResyncSchema`, extend the union)
- Test: `packages/shared/src/protocol/schema.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/protocol/schema.test.ts`, add:

```ts
it('parses a valid resync message', () => {
  const r = ClientMessageSchema.safeParse({ v: 1, type: 'resync', fromOpId: 7 });
  expect(r.success).toBe(true);
});

it('rejects resync with a negative fromOpId', () => {
  const r = ClientMessageSchema.safeParse({ v: 1, type: 'resync', fromOpId: -1 });
  expect(r.success).toBe(false);
});
```

(`ClientMessageSchema` is imported in that file already; if not, add `import { ClientMessageSchema } from './schema.js';`.)

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -w @fiddle/shared -- src/protocol/schema.test.ts -t "resync"`
Expected: FAIL — `resync` is not a member of the discriminated union.

- [ ] **Step 3: Add the type**

In `packages/shared/src/protocol/types.ts`, add after `PongMessage` (line 51) and extend the union (line 53):

```ts
export interface ResyncMessage {
  v: 1;
  type: 'resync';
  fromOpId: number; // last opId the client has applied; replay everything after it
}

export type ClientMessage = HelloMessage | SetOpClient | PongMessage | ResyncMessage;
```

- [ ] **Step 4: Add the schema**

In `packages/shared/src/protocol/schema.ts`, add before `ClientMessageSchema` (line 30) and include it in the union:

```ts
export const ResyncSchema = VersionEnvelope.extend({
  type: z.literal('resync'),
  fromOpId: z.number().int().nonnegative(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  SetOpClientSchema,
  PongSchema,
  ResyncSchema,
]);
```

- [ ] **Step 5: Run it, verify it passes**

Run: `npm test -w @fiddle/shared -- src/protocol/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol/types.ts packages/shared/src/protocol/schema.ts packages/shared/src/protocol/schema.test.ts
git commit -m "feat(shared): add resync client message type + schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Server — factor catch-up + handle `resync`

**Why:** Replay-since-opId currently exists only inside `handleHello`. Factor it into a reusable helper and route the new `resync` message into it so a drifted peer can self-repair mid-session.

**Files:**
- Modify: `packages/server/src/sync/ConnectionHandler.ts` (add `sendCatchUp`, refactor `handleHello`, handle `resync` in `onMessage`)
- Test: `packages/server/src/sync/ConnectionHandler.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/server/src/sync/ConnectionHandler.test.ts`, add:

```ts
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
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -w @fiddle/server -- src/sync/ConnectionHandler.test.ts -t "resync replays"`
Expected: FAIL — `resync` is ignored (no `set` replay, no `sync.complete`).

- [ ] **Step 3: Factor the catch-up helper**

In `packages/server/src/sync/ConnectionHandler.ts`, add a private method (near `sendSnapshot`, ~line 405):

```ts
  // Replay ops after `resumeFrom` (or snapshot if evicted / fresh), then
  // sync.complete. Shared by the hello handshake and mid-session resync.
  private async sendCatchUp(resumeFrom: number, opIdHead: number): Promise<void> {
    if (resumeFrom >= 0 && resumeFrom <= opIdHead) {
      const ops = await this.store.getOpsSince(this.roomId, resumeFrom);
      if (ops === null) {
        await this.sendSnapshot(opIdHead);
      } else {
        for (const op of ops) {
          const broadcast: SetOpBroadcast = {
            v: 1, type: 'set', opId: op.opId, clientId: op.clientId,
            path: op.path, value: op.value,
          };
          this.socket.send(broadcast);
        }
      }
    } else if (resumeFrom > opIdHead) {
      const err: ErrorMessage = {
        v: 1, type: 'error', code: 'resume.client_ahead',
        message: `client opId ${resumeFrom} is ahead of server head ${opIdHead}`,
        fatal: false,
      };
      this.socket.send(err);
      await this.sendSnapshot(opIdHead);
    } else {
      await this.sendSnapshot(opIdHead);
    }
    const complete: SyncCompleteMessage = { v: 1, type: 'sync.complete', opId: opIdHead };
    this.socket.send(complete);
  }
```

Replace the catch-up block in `handleHello` (lines 342-383, from `// Catch-up:` through the `this.socket.send(complete);`) with:

```ts
    // Catch-up: replay from ring buffer when possible, otherwise snapshot.
    const resumeFrom = msg.resumeFromOpId ?? -1;
    await this.sendCatchUp(resumeFrom, opIdHead);
```

- [ ] **Step 4: Handle `resync` in `onMessage`**

In `packages/server/src/sync/ConnectionHandler.ts`, add after the `set` block in `onMessage` (after line 178, before the closing brace of `onMessage`):

```ts
    if (msg.type === 'resync') {
      if (!this.clientId) return;
      if (!this.bucket.consume()) return; // drop spammy resync requests silently
      const { opIdHead } = await this.store.getOrCreate(this.roomId, freshProject);
      await this.sendCatchUp(msg.fromOpId, opIdHead);
      return;
    }
```

- [ ] **Step 5: Run the suite, verify green**

Run: `npm test -w @fiddle/server -- src/sync/ConnectionHandler.test.ts`
Expected: PASS (new test + all existing hello/catch-up tests, which now flow through `sendCatchUp`).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/sync/ConnectionHandler.ts packages/server/src/sync/ConnectionHandler.test.ts
git commit -m "feat(server): mid-session resync via factored catch-up

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Client — opId-gap detection → request resync

**Why:** A connected peer that drops a broadcast frame silently drifts. Detect the gap (an inbound `set` whose `opId > lastSeen + 1`) and request a replay from the last applied opId.

**Files:**
- Modify: `packages/client/src/sync/WsClient.ts` (add `opIdLastSeen()` getter + `requestResync()`)
- Modify: `packages/client/src/sync/messageDispatch.ts:56-68` (gap check in the `set` case) and `DispatchDeps` (the `wsClient` shape already used; add the two methods to the consumed surface)
- Test: `packages/client/src/sync/WsClient.test.ts` and `packages/client/src/sync/messageDispatch.test.ts`

- [ ] **Step 1: Write the failing WsClient test**

In `packages/client/src/sync/WsClient.test.ts`, use the file's existing `makeClient()` + `driveLive(client, sock)` helpers (defined at the top of the file, `WsClient.test.ts:64-94`) to reach `live`, then add inside `describe('WsClient', ...)`:

```ts
it('requestResync sends a resync frame when live', () => {
  const { client } = makeClient();
  client.connect();
  const sock = MockWebSocket.instances[0];
  driveLive(client, sock);
  sock.sent.length = 0;
  client.requestResync(3);
  const frame = JSON.parse(sock.sent.at(-1)!);
  expect(frame).toMatchObject({ v: 1, type: 'resync', fromOpId: 3 });
});

it('suppresses a second resync until the next sync.complete', () => {
  const { client } = makeClient();
  client.connect();
  const sock = MockWebSocket.instances[0];
  driveLive(client, sock);
  sock.sent.length = 0;
  client.requestResync(3);
  client.requestResync(3); // suppressed — one outstanding
  expect(sock.sent.filter((s) => JSON.parse(s).type === 'resync')).toHaveLength(1);
  sock._msg(JSON.stringify({ v: 1, type: 'sync.complete', opId: 5 })); // clears the flag
  client.requestResync(5);
  expect(sock.sent.filter((s) => JSON.parse(s).type === 'resync')).toHaveLength(2);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -w @fiddle/client -- src/sync/WsClient.test.ts -t "requestResync"`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement on WsClient**

In `packages/client/src/sync/WsClient.ts`, add to the public API (e.g. after `nextClientSeq`, ~line 153):

```ts
  // Last opId this client has recorded as applied (from persisted sync state).
  // Used by the dispatcher to detect a gap in the broadcast stream.
  opIdLastSeen(): number {
    return this.getPersisted()?.opIdLastSeen ?? -1;
  }

  // Ask the server to replay everything after `fromOpId` (peer-drift repair).
  // No-op unless live. Guarded so a burst of gapped frames sends at most one
  // outstanding request; the flag clears on the next sync.complete.
  requestResync(fromOpId: number): void {
    if (this.state !== 'live') return;
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    this.send({ v: 1, type: 'resync', fromOpId });
  }
```

Add the field near the other private fields (~line 72):

```ts
  private resyncInFlight = false;
```

Clear it when catch-up completes — in `onSocketMessage`, the `sync.complete` case (lines 204-208):

```ts
      case 'sync.complete': {
        this.recordOpIdSeen(msg.opId);
        this.resyncInFlight = false;
        this.setState('live');
        this.backoff = INITIAL_BACKOFF_MS;
        break;
      }
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -w @fiddle/client -- src/sync/WsClient.test.ts -t "requestResync"`
Expected: PASS.

- [ ] **Step 5: Write the failing dispatch test**

In `packages/client/src/sync/messageDispatch.test.ts`, extend the shared `deps()` helper's `wsClient` mock with the two new methods (a harmless default so every existing test has them):

```ts
// in deps(): wsClient: { recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn() } as unknown as DispatchDeps['wsClient'],
```

Then add two tests that set `opIdLastSeen` locally so they don't depend on the helper's default:

```ts
it('requests a resync when an inbound set skips an opId', () => {
  const project = freshProject();
  const d = deps(project);
  (d.wsClient as any).opIdLastSeen = () => 5; // applied up to opId 5
  // opId 7 means opId 6 was missed.
  dispatchServerMessage({ v: 1, type: 'set', opId: 7, clientId: 'peer', path: ['bpm'], value: 130 }, d);
  expect(d.wsClient.requestResync).toHaveBeenCalledWith(5);
});

it('does not request a resync for a contiguous opId', () => {
  const project = freshProject();
  const d = deps(project);
  (d.wsClient as any).opIdLastSeen = () => 5;
  dispatchServerMessage({ v: 1, type: 'set', opId: 6, clientId: 'peer', path: ['bpm'], value: 130 }, d);
  expect(d.wsClient.requestResync).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `npm test -w @fiddle/client -- src/sync/messageDispatch.test.ts -t "resync"`
Expected: FAIL — `requestResync` not called (and possibly a TS error on the mock until the helper is extended).

- [ ] **Step 7: Implement the gap check**

In `packages/client/src/sync/messageDispatch.ts`, in the `set` case (lines 56-68), add the gap check at the top of the case (before the echo handling):

```ts
    case 'set': {
      // Peer-drift detection: a broadcast opId that skips ahead means we missed
      // an op. Ask the server to replay from our last applied opId; per-path
      // opId guards in applyOp keep the (newer) gapped op from being clobbered by
      // the (older) replayed ones.
      const lastSeen = deps.wsClient.opIdLastSeen();
      if (msg.opId > lastSeen + 1) {
        deps.wsClient.requestResync(lastSeen);
      }
      if (msg.clientSeq != null) {
        deps.outbox.onEcho(msg.clientSeq);
      }
      applyOp(deps.project, msg);
      if (msg.clientId !== selfClientId.value) {
        noteRemoteTouch(msg.path, msg.clientId);
      }
      deps.wsClient.recordOpIdSeen(msg.opId);
      return;
    }
```

Add the methods to the `DispatchDeps.wsClient` consumed surface. The dispatch already imports `WsClient`; since the real `WsClient` now has `opIdLastSeen` and `requestResync`, no interface change is needed — but confirm `DispatchDeps.wsClient` is typed as `WsClient` (it is, line 25). The test mocks supply both methods.

- [ ] **Step 8: Run the tests, verify they pass**

Run: `npm test -w @fiddle/client -- src/sync/messageDispatch.test.ts` then `npm test -w @fiddle/client -- src/sync/WsClient.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/sync/WsClient.ts packages/client/src/sync/WsClient.test.ts packages/client/src/sync/messageDispatch.ts packages/client/src/sync/messageDispatch.test.ts
git commit -m "feat(client): detect opId gaps and request a resync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Server — version-gated periodic flush (close the lost-update window)

**Why:** The documented `SessionSync` lost-update window can clear the dirty flag for an op applied mid-flush, so it never persists. Add a monotonic room version (bumped per op) and a conditional `clearDirty` that only clears if the version is unchanged since the read. No new writes — same cadence.

**Files:**
- Modify: `packages/server/src/room/types.ts:19-35` (add `version` to `RoomState`)
- Modify: `packages/server/src/room/RoomStore.ts:33-84` (add `roomVersion`, change `clearDirty` signature)
- Modify: `packages/server/src/room/InMemoryRoomStore.ts` (`getOrCreate`, `appendOp`, `roomVersion`, `clearDirty`)
- Modify: `packages/server/src/session/SessionSync.ts:42-55` (`flushRoom`)
- Test: `packages/server/src/room/InMemoryRoomStore.test.ts` and `packages/server/src/session/SessionSync.test.ts`

- [ ] **Step 1: Write the failing store test**

In `packages/server/src/room/InMemoryRoomStore.test.ts`, add:

```ts
describe('InMemoryRoomStore version-gated clearDirty', () => {
  it('bumps version per op and only clears dirty when version is unchanged', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r', freshProject);
    await store.appendOp('r', { clientId: 'c', clientSeq: 1, path: ['bpm'], value: 130 });
    const v1 = await store.roomVersion('r');

    // An op lands after we captured v1 (simulates a mid-flush write).
    await store.appendOp('r', { clientId: 'c', clientSeq: 2, path: ['bpm'], value: 131 });

    await store.clearDirty('r', v1!);                 // stale version → must NOT clear
    expect(await store.listDirtyRoomIds()).toContain('r');

    const v2 = await store.roomVersion('r');
    await store.clearDirty('r', v2!);                 // current version → clears
    expect(await store.listDirtyRoomIds()).not.toContain('r');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -w @fiddle/server -- src/room/InMemoryRoomStore.test.ts -t "version-gated"`
Expected: FAIL — `roomVersion` not a function / `clearDirty` ignores the version arg.

- [ ] **Step 3: Add `version` to `RoomState`**

In `packages/server/src/room/types.ts`, add to `RoomState` (after `dirty`, line 34):

```ts
  // Monotonic counter bumped by appendOp on every accepted op. Lets the autosave
  // flusher clear `dirty` conditionally — only if no op landed since it read the
  // project — closing the peek→save→clearDirty lost-update window.
  version: number;
```

- [ ] **Step 4: Update the RoomStore interface**

In `packages/server/src/room/RoomStore.ts`, add `roomVersion` and change `clearDirty` (replace lines 74-78):

```ts
  // Room ids with unsaved edits since their last flush.
  listDirtyRoomIds(): Promise<string[]>;

  // Monotonic version of a room's project (bumped per op); null if absent. Read
  // before a flush and passed back to clearDirty to detect mid-flush writes.
  roomVersion(roomId: string): Promise<number | null>;

  // Clears a room's dirty flag after a successful snapshot save. When `ifVersion`
  // is given, clears ONLY if the room's version is unchanged since it was read —
  // so an op applied mid-flush keeps the room dirty for the next sweep.
  clearDirty(roomId: string, ifVersion?: number): Promise<void>;
```

- [ ] **Step 5: Implement in InMemoryRoomStore**

In `packages/server/src/room/InMemoryRoomStore.ts`:

`getOrCreate` fresh-room literal (lines 26-34) — add `version: 0`:

```ts
      room = {
        project: freshProject(),
        opLog: [],
        nextOpId: 1,
        identities: new Map(),
        connected: new Set(),
        graceTimer: null,
        dirty: false,
        version: 0,
      };
```

`appendOp` — bump version alongside `dirty` (after line 65):

```ts
    room.nextOpId += 1;
    room.dirty = true;
    room.version += 1;
```

Replace `clearDirty` (lines 170-173) and add `roomVersion` next to it:

```ts
  async roomVersion(roomId: string): Promise<number | null> {
    return this.rooms.get(roomId)?.version ?? null;
  }

  async clearDirty(roomId: string, ifVersion?: number): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (ifVersion !== undefined && room.version !== ifVersion) return; // op landed mid-flush
    room.dirty = false;
  }
```

- [ ] **Step 6: Use the version in SessionSync.flushRoom**

In `packages/server/src/session/SessionSync.ts`, replace `flushRoom` (lines 42-55) — keep the comment but update the body to read+pass the version:

```ts
  async flushRoom(roomId: string): Promise<void> {
    const project = await this.rooms.peekProject(roomId);
    if (!project) return; // room gone (pruned) — nothing to persist
    // Capture the version at read time; clearDirty below only clears if no op has
    // landed since, so a write racing the async save isn't lost (it stays dirty
    // and the next sweep retries).
    const version = await this.rooms.roomVersion(roomId);
    try {
      await this.sessions.saveSnapshot(roomId, normalizeProject(project));
      await this.rooms.clearDirty(roomId, version ?? undefined);
    } catch (err) {
      this.log('session flush failed', { roomId, err });
    }
  }
```

Update the "Known limitation (deferred)" comment block above `flushRoom` (lines 30-41) to note the window is now closed by the version-gated `clearDirty` (remove the "deferred" framing).

- [ ] **Step 7: Run the tests, verify they pass**

Run: `npm test -w @fiddle/server -- src/room/InMemoryRoomStore.test.ts` then `npm test -w @fiddle/server -- src/session/SessionSync.test.ts` then `npm test -w @fiddle/server -- src/room/InMemoryRoomStore.persistence.test.ts`
Expected: PASS. `SessionSync.test.ts` and the persistence test both use the **real** `InMemoryRoomStore` (no hand-rolled mock), so no mock updates are needed. `InMemoryRoomStore` is the only `RoomStore` implementor; `clearDirty('r1')` (no version) in `persistence.test.ts` stays valid because `ifVersion` is optional.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/room/types.ts packages/server/src/room/RoomStore.ts packages/server/src/room/InMemoryRoomStore.ts packages/server/src/session/SessionSync.ts packages/server/src/room/InMemoryRoomStore.test.ts packages/server/src/session/SessionSync.test.ts
git commit -m "fix(server): version-gated clearDirty closes the lost-update window

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green across `@fiddle/shared`, `@fiddle/client`, `@fiddle/server`.

- [ ] **Telemetry sanity check (manual, optional but recommended)**

With the local observability stack (`FIDDLE_OTEL=1`), drive two clients and confirm in OpenObserve:
- every local edit produces a server-side inbound `set` (`fiddle.ws.frames`, `ws.dir=in`, `ws.type=set`);
- resend / `resync` frames trend to ~0 in steady state;
- `fiddle.db.calls` is **unchanged** vs. before this work (proves no new DB load — the core constraint).

---

## Notes for the implementer

- **No new DB writes anywhere.** Task 11 changes *when* the dirty flag clears, not how often we write. If any task tempts you to persist per-op, stop — it's explicitly out of scope.
- **Multi-user same-leaf reconcile is deferred** (see spec §3 Piece 2). `reassertPending` re-asserts un-acked edits unconditionally; that's correct for the single-author case this work targets. Do not add per-leaf op-versioning here.
- **`op.duplicate` `NackCode`** stays in the type union (Task 2 just stops *emitting* it). Leave it; removing it is unrelated churn.
- **Fake timers:** the Outbox tests use `vi.useFakeTimers()` — `ACK_TIMEOUT_MS` resend tests rely on `vi.advanceTimersByTime`. Don't switch them to real timers.
