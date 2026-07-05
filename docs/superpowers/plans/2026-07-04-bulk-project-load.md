# Bulk Project Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the lossy whole-project op-storm (OPEN/NEW in a live session) with an atomic client→server `load` protocol message; the server validates, replaces the room doc, and rebroadcasts the existing `SnapshotMessage`.

**Architecture:** Additive protocol change, capability-gated. Server: `RoomStore.replaceProject` clears the op ring buffer so pre-load watermarks fall into the existing snapshot catch-up path; `ConnectionHandler` gets a `load` branch with its own 1-per-2s budget. Client: `WsClient` records `welcome.capabilities`; a new `LoadTracker` (beside the Outbox) owns the single in-flight load with nack-rollback and resend-once; `projectOps` sends one `load` instead of `enqueueWholeProjectDiff` when the capability is present (the diff path stays as fallback for old servers).

**Tech Stack:** TypeScript monorepo (npm workspaces `@fiddle/shared`, `@fiddle/server`, `@fiddle/client`), Zod, Fastify + @fastify/websocket, Vue 3, Vitest.

**Source spec:** `docs/superpowers/specs/2026-07-04-bulk-project-load-design.md` (approved). Read it if a requirement here seems ambiguous — the spec governs.

**Plan-time verifications (already resolved — no task needed):** (1) mid-session snapshots ARE applied unconditionally (`messageDispatch.ts` `case 'snapshot'` runs in every state), so peers converge on a load with no ungating work; (2) `@fastify/websocket` is registered with default options (1 MiB maxPayload) — Task 3 makes it explicit at 2 MiB; (3) `Schemas` and `normalizeProject` are exported from the `@fiddle/shared` root barrel.

## Global Constraints

- Branch: `feat/bulk-project-load` (already checked out; spec committed as `f518fe9`). NEVER commit to main.
- Stage ONLY the files you created/modified, by name. NEVER `git add -A`/`-u`. NEVER stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png` (untracked scratch in repo root).
- Every commit message ends with these two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir`
- Test commands: shared `npm run -w @fiddle/shared test -- --run`, server `npm run -w @fiddle/server test -- --run`, client `npm run -w @fiddle/client test -- --run`, client typecheck `npm run -w @fiddle/client typecheck`.
- Capability string is exactly `'load'`. Load budget is exactly 1 load per `2000` ms per connection. Load ack timeout reuses `5000` ms (same value as the Outbox ACK timeout). ws `maxPayload` is exactly `2 * 1024 * 1024`.
- The client MUST NOT send a `load` message unless the welcome carried the `'load'` capability (old servers fatally close on unknown message types).
- Never run `npm run dev` (real prod DB). Local manual testing uses `npm run dev:obs` only.

---

### Task 1: Shared protocol — `LoadMessage` + welcome `capabilities`

**Files:**
- Modify: `packages/shared/src/protocol/types.ts`
- Modify: `packages/shared/src/protocol/schema.ts`
- Test: `packages/shared/src/protocol/schema.test.ts` (exists — append cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface LoadMessage { v: 1; type: 'load'; clientSeq: number; project: unknown }` exported from types.ts and included in the `ClientMessage` union; `WelcomeMessage.capabilities?: string[]`; `LoadSchema` included in `ClientMessageSchema`. All re-exported through the existing `packages/shared/src/protocol/index.ts` barrel (verify it re-exports `types.js` and `schema.js` wholesale; if it names exports individually, add the new ones).

- [ ] **Step 1: Write the failing tests** — append to `packages/shared/src/protocol/schema.test.ts`:

```ts
describe('LoadMessage', () => {
  it('accepts a well-formed load message', () => {
    const r = ClientMessageSchema.safeParse({
      v: 1, type: 'load', clientSeq: 7, project: { anything: true },
    });
    expect(r.success).toBe(true);
  });

  it('rejects load without clientSeq', () => {
    const r = ClientMessageSchema.safeParse({ v: 1, type: 'load', project: {} });
    expect(r.success).toBe(false);
  });

  it('still rejects unknown message types', () => {
    const r = ClientMessageSchema.safeParse({ v: 1, type: 'bulk', project: {} });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w @fiddle/shared test -- --run schema`
Expected: FAIL — the well-formed `load` message is rejected (not in the union yet).

- [ ] **Step 3: Implement.** In `types.ts`, after `ResyncMessage`:

```ts
// Atomic whole-project replace (spec 2026-07-04-bulk-project-load-design).
// Sent instead of a per-leaf diff on OPEN/NEW so a big import can't overflow
// the op rate limit. `project` is untyped on the wire — the server validates
// with Schemas.Project + normalizeProject before applying.
export interface LoadMessage {
  v: 1;
  type: 'load';
  clientSeq: number; // same counter as set ops — unique per connection
  project: unknown;
}
```

Update the union: `export type ClientMessage = HelloMessage | SetOpClient | PongMessage | ResyncMessage | LoadMessage;`

In `WelcomeMessage`, after `roster`:

```ts
  // Server feature advertisement. Present servers send ['load']; the client
  // must not send a LoadMessage unless this includes 'load' (older servers
  // fatally close on unknown message types).
  capabilities?: string[];
```

In `schema.ts`, after `ResyncSchema`:

```ts
export const LoadSchema = VersionEnvelope.extend({
  type: z.literal('load'),
  clientSeq: z.number().int().nonnegative(),
  project: z.unknown(),
});
```

Add `LoadSchema` to the `ClientMessageSchema` discriminated union array.

- [ ] **Step 4: Run tests**

Run: `npm run -w @fiddle/shared test -- --run`
Expected: PASS (full shared suite — the append-only change must not break existing cases).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol/types.ts packages/shared/src/protocol/schema.ts packages/shared/src/protocol/schema.test.ts
git commit -m "feat(shared): LoadMessage client op + welcome capabilities advertisement"
```

---

### Task 2: Server store — `RoomStore.replaceProject`

**Files:**
- Modify: `packages/server/src/room/RoomStore.ts`
- Modify: `packages/server/src/room/InMemoryRoomStore.ts`
- Test: `packages/server/src/room/InMemoryRoomStore.test.ts` (exists — append cases)

**Interfaces:**
- Consumes: existing `RoomState` (`room/types.ts`: `project`, `opLog: AppliedOp[]`, `opIndex: Map`, `nextOpId`, `dirty`, `version`).
- Produces: `replaceProject(roomId: string, project: Project): Promise<{ opId: number }>` on the `RoomStore` interface and `InMemoryRoomStore`.

- [ ] **Step 1: Write the failing tests** — append to `InMemoryRoomStore.test.ts` (use the file's existing helpers for creating a store/room; the assertions below are the contract):

```ts
describe('replaceProject', () => {
  it('swaps the doc, advances head, and clears replayability', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    await store.appendOp('r1', { clientId: 'c1', clientSeq: 1, path: ['bpm'], value: 97 });
    const headBefore = (await store.getOrCreate('r1', freshProject)).opIdHead;

    const next = freshProject();
    next.bpm = 63;
    const { opId } = await store.replaceProject('r1', next);

    expect(opId).toBe(headBefore + 1);
    const { project, opIdHead } = await store.getOrCreate('r1', freshProject);
    expect(project.bpm).toBe(63);
    expect(opIdHead).toBe(opId);
    // Pre-load watermarks must take the snapshot path…
    expect(await store.getOpsSince('r1', headBefore)).toBeNull();
    expect(await store.getOpsSince('r1', 0)).toBeNull();
    // …but a client already at the new head needs nothing.
    expect(await store.getOpsSince('r1', opId)).toEqual([]);
  });

  it('marks the room dirty and bumps version (autosave contract)', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    const v0 = await store.roomVersion('r1');
    await store.clearDirty('r1');
    await store.replaceProject('r1', freshProject());
    expect(await store.listDirtyRoomIds()).toContain('r1');
    expect(await store.roomVersion('r1')).toBe((v0 ?? 0) + 1);
  });

  it('appendOp after a load continues the opId sequence', async () => {
    const store = new InMemoryRoomStore();
    await store.getOrCreate('r1', freshProject);
    const { opId } = await store.replaceProject('r1', freshProject());
    const r = await store.appendOp('r1', { clientId: 'c1', clientSeq: 2, path: ['bpm'], value: 80 });
    expect(r.ok && r.op.opId).toBe(opId + 1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w @fiddle/server test -- --run InMemoryRoomStore`
Expected: FAIL — `replaceProject is not a function`.

- [ ] **Step 3: Implement.** In `RoomStore.ts`, add to the interface (after `getOpsSince`) and extend the header invariants comment:

```ts
  // Atomically replace the room's project (bulk load). Consumes one opId,
  // CLEARS the op log (a load is a deliberate replay horizon: getOpsSince from
  // any pre-load watermark returns null, pushing the caller onto the snapshot
  // path — same contract as ring-buffer eviction), bumps roomVersion, and
  // marks the room dirty for the autosave flusher. Room must already exist.
  replaceProject(roomId: string, project: Project): Promise<{ opId: number }>;
```

In `InMemoryRoomStore.ts` (after `getOpsSince`):

```ts
  async replaceProject(roomId: string, project: Project): Promise<{ opId: number }> {
    const room = this.requireRoom(roomId);
    room.project = project;
    // The log describes edits to the PREVIOUS doc — clear both structures so
    // resume-from-before-the-load falls into getOpsSince's null → snapshot path.
    room.opLog = [];
    room.opIndex.clear();
    const opId = room.nextOpId;
    room.nextOpId += 1;
    room.dirty = true;
    room.version += 1;
    return { opId };
  }
```

- [ ] **Step 4: Run tests**

Run: `npm run -w @fiddle/server test -- --run InMemoryRoomStore`
Expected: PASS (including the pre-existing cases in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/room/RoomStore.ts packages/server/src/room/InMemoryRoomStore.ts packages/server/src/room/InMemoryRoomStore.test.ts
git commit -m "feat(server): RoomStore.replaceProject — atomic doc swap with replay horizon"
```

---

### Task 3: Server handler — `load` branch, capabilities, maxPayload

**Files:**
- Modify: `packages/server/src/sync/ConnectionHandler.ts`
- Modify: `packages/server/src/server.ts` (line ~80: `app.register(websocket)`)
- Test: `packages/server/src/sync/ConnectionHandler.test.ts` (append)
- Test: `packages/server/src/sync/protocol.e2e.test.ts` (append)

**Interfaces:**
- Consumes: `LoadMessage` in `ClientMessageSchema` (Task 1); `store.replaceProject` (Task 2); existing `Schemas`, `normalizeProject` from `@fiddle/shared`; existing `this.pool.all(roomId)`, `this.nack(...)`, `SnapshotMessage`.
- Produces: welcome messages carry `capabilities: ['load']`; a valid `load` yields a `SnapshotMessage` broadcast to every socket in the room (originator included).

- [ ] **Step 1: Write the failing handler tests.** Append to `ConnectionHandler.test.ts`, following the file's existing harness pattern (mock socket + store + pool; look at how the existing `set`-op tests construct a handler and drive `onMessage`). The behavioral contract to assert:

```ts
describe('load message', () => {
  it('welcome advertises the load capability', async () => {
    // drive a hello; assert the welcome sent to the socket has
    // capabilities: ['load']
  });

  it('valid load replaces the doc and broadcasts a snapshot to all sockets', async () => {
    // two connected sockets in the room; originator sends
    // { v:1, type:'load', clientSeq: 1, project: <valid Project (freshProject() with bpm 63)> }
    // assert: store.replaceProject called with the NORMALIZED project;
    // BOTH sockets received { type:'snapshot', opId: <replaceProject's opId>, project: <normalized> };
    // no nack sent.
  });

  it('invalid project nacks value.invalid and does not touch the store', async () => {
    // send { v:1, type:'load', clientSeq: 2, project: { bpm: 'NaN' } }
    // assert: nack { clientSeq: 2, code: 'value.invalid' }; replaceProject NOT called;
    // no snapshot broadcast.
  });

  it('second load within 2s nacks rate.limited', async () => {
    // send two valid loads back-to-back; second gets
    // nack { code: 'rate.limited' } and replaceProject is called exactly once.
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w @fiddle/server test -- --run ConnectionHandler`
Expected: FAIL — no `capabilities` on welcome; `load` messages fall through (schema now accepts them, handler ignores them).

- [ ] **Step 3: Implement the handler branch.** In `ConnectionHandler.ts`:

Imports: add `Schemas`, `normalizeProject`, and type `Project` to the existing `@fiddle/shared` import.

Fields (near `private bucket = new TokenBucket();`):

```ts
  // Loads replace the whole doc — one message, whole-project blast radius —
  // so they get their own coarse budget instead of the per-op TokenBucket.
  private lastLoadAtMs = 0;
```

Module constant (near the other constants at the top):

```ts
const LOAD_MIN_INTERVAL_MS = 2000;
```

New branch in `onMessage`, after the `resync` branch:

```ts
    if (msg.type === 'load') {
      if (!this.clientId) return;
      const now = Date.now();
      if (now - this.lastLoadAtMs < LOAD_MIN_INTERVAL_MS) {
        this.nack(msg.clientSeq, 'rate.limited', 'load rate limit exceeded');
        return;
      }
      // Consume the budget even when validation fails below: a client spamming
      // oversized/garbage payloads should not get free validation passes.
      this.lastLoadAtMs = now;
      const parsed = Schemas.Project.safeParse(msg.project);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        this.nack(
          msg.clientSeq,
          'value.invalid',
          issue ? `${issue.path.join('.') || '<root>'}: ${issue.message}` : 'invalid project',
        );
        return;
      }
      const normalized = normalizeProject(parsed.data as unknown as Project);
      const { opId } = await this.store.replaceProject(this.roomId, normalized);
      const snapshot: SnapshotMessage = { v: 1, type: 'snapshot', opId, project: normalized };
      // Everyone converges on the new doc; the originator's copy doubles as the ack.
      for (const sock of this.pool.all(this.roomId)) {
        sock.send(snapshot);
      }
      return;
    }
```

In `handleHello` where the `welcome` object is built (line ~363), add `capabilities: ['load'],` after `roster`.

In `server.ts`, change the websocket registration:

```ts
  // maxPayload must admit a whole-project LoadMessage (a fully-populated
  // 32-track project serializes to ~270 KB; @fastify/websocket's default cap
  // is 1 MiB — set explicitly so the headroom is documented, not accidental).
  app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
```

- [ ] **Step 4: Run handler tests**

Run: `npm run -w @fiddle/server test -- --run ConnectionHandler`
Expected: PASS.

- [ ] **Step 5: Write the e2e regression test.** Append to `protocol.e2e.test.ts`, following the file's existing two-client test pattern. Scenario (this is the regression for the 266-op data-loss bug):

```ts
it('bulk load: a large project replaces the room losslessly for both clients', async () => {
  // 1. Connect clients A and B; both reach sync.complete.
  // 2. Build `big`: freshProject() where tracks 0..7 are enabled with
  //    engineType 'synth2', non-default bpm, and for each of the 8 tracks set
  //    ~35 distinct synth2 leaves (loop the SYNTH2_DESCRIPTORS import and set
  //    each continuous param to (min+max)/2) — i.e. >266 changed leaves total.
  // 3. A sends { v:1, type:'load', clientSeq: <next>, project: big }.
  // 4. Both A and B receive a snapshot; deep-equal snapshot.project's tracks
  //    0..7 synth2 slices + bpm against `big` (post-normalizeProject).
  // 5. Assert NO nack of any kind was received by A.
  // 6. B sends a normal set op afterwards; both receive the broadcast with
  //    opId === snapshot.opId + 1 (sequence continues past the load).
});
```

- [ ] **Step 6: Run the full server suite**

Run: `npm run -w @fiddle/server test -- --run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/sync/ConnectionHandler.ts packages/server/src/server.ts packages/server/src/sync/ConnectionHandler.test.ts packages/server/src/sync/protocol.e2e.test.ts
git commit -m "feat(server): load message — validate, replaceProject, snapshot broadcast; advertise capability"
```

---

### Task 4: Client transport — capabilities, LoadTracker, dispatch, SyncSession

**Files:**
- Modify: `packages/client/src/sync/WsClient.ts`
- Create: `packages/client/src/sync/LoadTracker.ts`
- Create: `packages/client/src/sync/LoadTracker.test.ts`
- Modify: `packages/client/src/sync/messageDispatch.ts`
- Modify: `packages/client/src/sync/SyncSession.ts`
- Test: `packages/client/src/sync/SyncSession.test.ts` (append; follow its existing fake-WsClient pattern)

**Interfaces:**
- Consumes: `LoadMessage` from `@fiddle/shared` (Task 1); existing `WsClient.nextClientSeq()`, `WsClient.send()`, `CommandBus.loadProject`.
- Produces (later tasks rely on these exact names):
  - `WsClient.serverCapabilities: ReadonlyArray<string>` (empty until welcome).
  - `class LoadTracker` with `begin(msg: LoadMessage, prior: Project)`, `onSnapshot(): void`, `onNack(clientSeq: number, code: string, message: string): boolean`, `onClosed(): void`, `get hasPending(): boolean`.
  - `SyncSession.canBulkLoad: boolean` (getter), `SyncSession.sendProjectLoad(project: Project, prior: Project): void`, `SyncSession.loadError: Ref<string | null>`.
  - `DispatchDeps.loadTracker: LoadTracker`.

- [ ] **Step 1: Write the failing LoadTracker tests** — create `packages/client/src/sync/LoadTracker.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoadTracker } from './LoadTracker';
import type { LoadMessage } from '@fiddle/shared';

const msg = (clientSeq: number): LoadMessage =>
  ({ v: 1, type: 'load', clientSeq, project: {} });
const prior = { bpm: 111 } as any;

describe('LoadTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = () => {
    const deps = {
      send: vi.fn(),
      rollback: vi.fn(),
      onError: vi.fn(),
      ackTimeoutMs: 5000,
    };
    return { deps, tracker: new LoadTracker(deps) };
  };

  it('snapshot arrival clears the pending load', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    expect(tracker.hasPending).toBe(true);
    tracker.onSnapshot();
    expect(tracker.hasPending).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
  });

  it('matching nack rolls back to prior and reports the error', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    expect(tracker.onNack(1, 'value.invalid', 'bad project')).toBe(true);
    expect(deps.rollback).toHaveBeenCalledWith(prior);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(tracker.hasPending).toBe(false);
  });

  it('non-matching nack is ignored (returns false, no rollback)', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    expect(tracker.onNack(9, 'value.invalid', 'other op')).toBe(false);
    expect(deps.rollback).not.toHaveBeenCalled();
    expect(tracker.hasPending).toBe(true);
  });

  it('ack timeout resends once, then rolls back and errors', () => {
    const { deps, tracker } = make();
    const m = msg(1);
    tracker.begin(m, prior);
    vi.advanceTimersByTime(5000);
    expect(deps.send).toHaveBeenCalledExactlyOnceWith(m);
    expect(tracker.hasPending).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(deps.rollback).toHaveBeenCalledWith(prior);
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(tracker.hasPending).toBe(false);
  });

  it('socket close drops the pending load without rollback (snapshot-on-resume settles it)', () => {
    const { deps, tracker } = make();
    tracker.begin(msg(1), prior);
    tracker.onClosed();
    expect(tracker.hasPending).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.rollback).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w @fiddle/client test -- --run LoadTracker`
Expected: FAIL — module `./LoadTracker` not found.

- [ ] **Step 3: Implement `LoadTracker.ts`:**

```ts
// LoadTracker — the single in-flight whole-project load (spec
// 2026-07-04-bulk-project-load-design). Lives BESIDE the Outbox, not inside
// it: the Outbox is per-leaf with per-path coalescing; a load is one atomic
// message whose rollback is the entire prior project.
//
// Lifecycle: begin() on send → cleared by the first snapshot arrival (ours or
// a concurrent peer's — last-write-wins, same as op semantics), by a matching
// nack (rollback to prior), or by onClosed() (a reconnect that resumes from a
// pre-load watermark hits the server's cleared op log and gets a snapshot, so
// state settles without client-side bookkeeping).

import type { LoadMessage, Project } from '@fiddle/shared';

export interface LoadTrackerDeps {
  /** Re-send the original LoadMessage (resend-once on ack timeout). */
  send: (msg: LoadMessage) => void;
  /** Restore the pre-load project (terminal failure only). */
  rollback: (prior: Project) => void;
  /** Surface a terminal load failure to the user. */
  onError: (message: string) => void;
  /** Test seam; defaults to 5000 (same as the Outbox ACK timeout). */
  ackTimeoutMs?: number;
}

interface PendingLoad {
  msg: LoadMessage;
  prior: Project;
  timer: ReturnType<typeof setTimeout> | null;
  resent: boolean;
}

export class LoadTracker {
  private pending: PendingLoad | null = null;

  constructor(private readonly deps: LoadTrackerDeps) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  begin(msg: LoadMessage, prior: Project): void {
    this.clearTimer();
    this.pending = { msg, prior, timer: null, resent: false };
    this.armTimer();
  }

  /** Any snapshot confirms or supersedes the pending load. */
  onSnapshot(): void {
    this.clearTimer();
    this.pending = null;
  }

  /** True when the nack matched the pending load (caller stops routing it). */
  onNack(clientSeq: number, code: string, message: string): boolean {
    if (!this.pending || this.pending.msg.clientSeq !== clientSeq) return false;
    const { prior } = this.pending;
    this.clearTimer();
    this.pending = null;
    this.deps.rollback(prior);
    this.deps.onError(`Project load rejected (${code}): ${message}`);
    return true;
  }

  /** Socket died mid-load: drop it; the resume/snapshot path settles state. */
  onClosed(): void {
    this.clearTimer();
    this.pending = null;
  }

  private armTimer(): void {
    const pending = this.pending!;
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      if (!pending.resent) {
        pending.resent = true;
        // Idempotent by construction: the server replaces with identical
        // content and re-broadcasts a snapshot.
        this.deps.send(pending.msg);
        this.armTimer();
        return;
      }
      this.pending = null;
      this.deps.rollback(pending.prior);
      this.deps.onError('Project load timed out');
    }, this.deps.ackTimeoutMs ?? 5000);
  }

  private clearTimer(): void {
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer);
      this.pending.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run LoadTracker tests**

Run: `npm run -w @fiddle/client test -- --run LoadTracker`
Expected: PASS.

- [ ] **Step 5: Wire capabilities + dispatch + session.**

`WsClient.ts` — public field (near `state`):

```ts
  // Server feature advertisement from the last welcome. Transport-level fact:
  // consumers gate LoadMessage sends on this (old servers fatally close on
  // unknown message types).
  serverCapabilities: ReadonlyArray<string> = [];
```

In the `case 'welcome':` branch (before `this.setState('catching-up')`):

```ts
        this.serverCapabilities = msg.capabilities ?? [];
```

`messageDispatch.ts` — extend `DispatchDeps`:

```ts
  loadTracker: LoadTracker;
```

(import `type { LoadTracker } from './LoadTracker.js';`)

In `case 'snapshot':` add as the first line:

```ts
      // A snapshot confirms (ours) or supersedes (a peer's) any pending load.
      deps.loadTracker.onSnapshot();
```

Replace the `case 'nack':` body:

```ts
    case 'nack':
      // A load nack matches here and never reaches the per-leaf Outbox path
      // (loads and set ops share the clientSeq counter, so seqs are disjoint).
      if (deps.loadTracker.onNack(msg.clientSeq, msg.code, msg.message)) return;
      deps.outbox.onNack(msg.clientSeq, msg.code);
      return;
```

`SyncSession.ts`:

- Fields: `readonly loadError: Ref<string | null> = ref(null);` and `private loadTracker: LoadTracker | null = null;`
- Imports: `LoadTracker` from `./LoadTracker`, `type { LoadMessage, Project }` added to the `@fiddle/shared` type import.
- In `buildConnection`, after the Outbox is constructed:

```ts
    this.loadTracker = new LoadTracker({
      send: (msg) => {
        // Best-effort resend; a dead socket surfaces via onStateChange('closed')
        // → loadTracker.onClosed(), so a throw here is benign.
        try { this.wsClient?.send(msg); } catch { /* settled by reconnect snapshot */ }
      },
      rollback: (prior) => this.deps.bus.loadProject(prior),
      onError: (message) => { this.loadError.value = message; },
    });
```

- In `buildConnection`'s `onMessage`, pass `loadTracker: this.loadTracker!,` into `dispatchServerMessage` deps.
- In `onStateChange`, extend the closed handler: `if (s === 'closed') { this.outbox?.onClosed(); this.loadTracker?.onClosed(); }` (preserve the existing `this.outbox &&` guard semantics).
- In `disconnect()`, add `this.loadTracker = null;` next to `this.outbox = null;` and `this.loadError.value = null;`.
- Public API (near `enqueue`):

```ts
  // Bulk-load path is available only when the room is live AND the server
  // advertised the capability (old servers fatally close on unknown types).
  get canBulkLoad(): boolean {
    return this.isSyncLive && (this.wsClient?.serverCapabilities.includes('load') ?? false);
  }

  // Send the whole project atomically (OPEN/NEW). `prior` is a full deep clone
  // of the pre-load project, held for nack/timeout rollback.
  sendProjectLoad(project: Project, prior: Project): void {
    if (!this.canBulkLoad || !this.wsClient || !this.loadTracker) return;
    const msg: LoadMessage = {
      v: 1, type: 'load', clientSeq: this.wsClient.nextClientSeq(), project,
    };
    this.loadTracker.begin(msg, prior);
    this.wsClient.send(msg);
  }
```

- [ ] **Step 6: Write the failing SyncSession tests** — append to `SyncSession.test.ts` using its existing fake-WsClient/factory pattern. Contract to assert:

```ts
describe('bulk load', () => {
  it('canBulkLoad is false before live, true once live with the capability', () => {
    // fake ws advertises serverCapabilities ['load']; before sync.complete →
    // false; after → true.
  });

  it('canBulkLoad is false when the server lacks the capability', () => {
    // fake ws with serverCapabilities [] stays false even when live.
  });

  it('sendProjectLoad sends one load message with a minted clientSeq', () => {
    // capture ws.send calls; assert exactly one { type:'load', clientSeq, project }.
  });

  it('load nack routes to rollback via bus.loadProject and sets loadError', () => {
    // drive dispatchServerMessage with a nack matching the pending load's
    // clientSeq; assert bus.loadProject(prior) and session.loadError.value set;
    // assert outbox.onNack NOT called for that seq.
  });
});
```

- [ ] **Step 7: Run the client suite + typecheck**

Run: `npm run -w @fiddle/client typecheck && npm run -w @fiddle/client test -- --run`
Expected: PASS. (Existing `messageDispatch`/`SyncSession` tests will need the new `loadTracker` dep — construct a real `LoadTracker` with vi.fn() deps in their fixtures.)

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/sync/WsClient.ts packages/client/src/sync/LoadTracker.ts packages/client/src/sync/LoadTracker.test.ts packages/client/src/sync/messageDispatch.ts packages/client/src/sync/SyncSession.ts packages/client/src/sync/SyncSession.test.ts
git commit -m "feat(client): LoadTracker + capability-gated sendProjectLoad on SyncSession"
```

---

### Task 5: Client app — projectOps bulk path + error surfacing

**Files:**
- Modify: `packages/client/src/app/projectOps.ts`
- Modify: `packages/client/src/app/synthContext.ts` (createProjectOps call ~line 53; context export ~line 212)
- Modify: `packages/client/src/views/StudioView.vue`
- Test: `packages/client/src/app/synthContext.test.ts` (append; it already exercises projectOps wiring)

**Interfaces:**
- Consumes: `SyncSession.canBulkLoad`, `SyncSession.sendProjectLoad(project, prior)`, `SyncSession.loadError` (Task 4).
- Produces: `ProjectOpsDeps` gains `canBulkLoad: () => boolean` and `sendLoad: (project: Project, prior: Project) => void`; synth context exposes `loadError: Ref<string | null>`.

- [ ] **Step 1: Write the failing tests** — append to `synthContext.test.ts` (it runs with sync disabled by default; use the same technique its existing sync-path tests use to install a fake session):

```ts
describe('openProject bulk path', () => {
  it('uses sendLoad (one call, zero enqueues) when canBulkLoad', () => {
    // fake session: isSyncLive true, canBulkLoad true; spies on sendProjectLoad
    // and enqueue. Call projectOps.openProject(<distinctive project>).
    // Assert sendProjectLoad called once with (nextProject, priorClone) where
    // priorClone deep-equals the pre-open project and is NOT the same object
    // reference; assert enqueue was never called.
  });

  it('falls back to the leaf diff when the capability is absent', () => {
    // fake session: isSyncLive true, canBulkLoad false. openProject must call
    // enqueue at least once (bpm leaf) and sendProjectLoad never.
  });

  it('offline: neither sendLoad nor enqueue (local-only, unchanged)', () => {
    // isSyncLive false → bus.loadProject applied, no outbound calls.
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w @fiddle/client test -- --run synthContext`
Expected: FAIL — `canBulkLoad`/`sendLoad` missing from `ProjectOpsDeps`.

- [ ] **Step 3: Implement.** `projectOps.ts`:

Add `import { toRaw } from 'vue';` and extend `ProjectOpsDeps`:

```ts
  /** Bulk-load availability (live room + server capability). */
  canBulkLoad: () => boolean;
  /** Atomic whole-project send; `prior` is the pre-load clone for rollback. */
  sendLoad: (project: Project, prior: Project) => void;
```

Replace `loadAndSyncWholeProject`:

```ts
  function loadAndSyncWholeProject(next: Project): void {
    const live = deps.isSyncLive();
    const bulk = live && deps.canBulkLoad();
    // prior = full-Project deep clone of pre-load live state, for nack/timeout
    // rollback. toRaw strips Vue proxies (same pattern as serializeProject).
    const prior = bulk ? (structuredClone(toRaw(project)) as Project) : null;
    const before = live && !bulk ? snapshotProjectForSync() : null;
    bus.loadProject(next);
    if (bulk) deps.sendLoad(next, prior!);            // one atomic message
    else if (before) enqueueWholeProjectDiff(before); // fallback: old servers
    // offline/solo (neither): unchanged local-only behavior
  }
```

`synthContext.ts` — extend the `createProjectOps({...})` deps:

```ts
    canBulkLoad: () => session.canBulkLoad,
    sendLoad: (next, prior) => session.sendProjectLoad(next, prior),
```

and export `loadError: session.loadError,` from the context object (next to wherever `fatalError`/`roomLoading` are exposed).

`StudioView.vue` — surface terminal load failures with the existing dialog (script setup; `dialog = useDialog()` already exists):

```ts
const { loadError } = synth; // however the context is destructured in this file
watch(loadError, (msg) => {
  if (!msg) return;
  loadError.value = null;
  void dialog.alert(`Could not sync the loaded project: ${msg}`);
});
```

- [ ] **Step 4: Run the client gate**

Run: `npm run -w @fiddle/client typecheck && npm run -w @fiddle/client test -- --run`
Expected: PASS (707+ tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/app/projectOps.ts packages/client/src/app/synthContext.ts packages/client/src/views/StudioView.vue packages/client/src/app/synthContext.test.ts
git commit -m "feat(client): OPEN/NEW use the atomic load path when the server supports it"
```

---

### Task 6: Docs + backlog

**Files:**
- Modify: `docs/ARCHITECTURE.md` (Decisions appendix — append D19)
- Modify: `docs/BACKLOG.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Append decision D19 to `docs/ARCHITECTURE.md`** (follow the D18 entry's format):

```markdown
### D19 — Bulk project load is a protocol message, not an op storm (2026-07-04)

OPEN/NEW in a live session used to sync via the whole-project leaf diff — one
`set` op per changed leaf. Any import over the server's per-connection budget
(TokenBucket: burst 200, 100 ops/sec) had its tail nacked `rate.limited`, and
the Outbox rolls nacked leaves back to their priors — during an import, blank
defaults. Silent, timing-dependent data loss (reproduced 2026-07-04 with a
266-op project).

Now: the client sends one `load` message (full project); the server validates
(Schemas.Project + normalizeProject), atomically replaces the room doc via
`RoomStore.replaceProject` (consumes one opId, CLEARS the op log so any
pre-load watermark falls into the existing snapshot catch-up path), and
broadcasts the existing `SnapshotMessage` to every socket — the originator's
copy doubles as the ack. Capability-gated: welcome advertises
`capabilities: ['load']`; without it the client falls back to the leaf diff
(old servers fatally close on unknown message types). Invariants:

- A load is a replay horizon: `getOpsSince(< load opId)` returns null.
- Loads share the clientSeq counter with set ops (disjoint seqs ⇒ nacks route
  unambiguously: LoadTracker first, Outbox otherwise).
- Loads are NOT deduped server-side; a resend re-applies identical content.
- One in-flight load per client (LoadTracker), resend-once on ack timeout,
  rollback-to-prior on nack/second timeout.
```

- [ ] **Step 2: Add two BACKLOG entries to `docs/BACKLOG.md`** (follow the file's existing entry format):

```markdown
- **Outbox treats `rate.limited` as authoritative** — any >200-op burst of
  regular set ops (e.g. FILL/CLEAR across several long tracks) still loses
  leaves: the tail is nacked and rolled back with no retry
  (`packages/client/src/sync/Outbox.ts` onNack ignores the code). The bulk
  load (D19) removed the biggest source, not the class. Fix direction:
  re-queue `rate.limited` nacks with backoff instead of rolling back.

- **Remove the whole-project diff fallback** — once prod is verified on the
  D19 load path, delete `snapshotProjectForSync` / `enqueueWholeProjectDiff` /
  `enqueueLeafDiff` / `enqueueMatrixDiff` from
  `packages/client/src/app/projectOps.ts` and the `capabilities` gate check
  (keep the welcome field). Blocked on: prod deploy + browser sign-off.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md docs/BACKLOG.md
git commit -m "docs: D19 bulk project load; backlog rate.limited rollback + fallback removal"
```

---

## Post-plan verification (controller, not a task)

Mandatory browser verification on `npm run dev:obs` before the branch is offered for merge — replay the exact 2026-07-04 repro:

1. Create a fresh session; stub `showOpenFilePicker` with `~/Desktop/___test-fiddle-project.prj.json` (serve it via a temp file in `packages/client/public/`, delete after); click OPEN.
2. Deep-compare live Pinia state against the file (all 32 tracks: engineType/enabled/patternLength/mixer/steps/engines) — **zero diffs required** (the pre-fix run lost 34+ leaves).
3. Hard reload; deep-compare again — zero diffs.
4. Confirm exactly one `load` frame and zero `set` frames were sent during the OPEN (server logs or a WsClient send spy via console).
5. Console clean; close tabs; remove the temp public file.
