# P0 Reload/Snapshot-Race Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the P0 reload-blank bug (docs/BACKLOG.md top entry) by repairing three sync-layer invariants: snapshot-required persists until satisfied, the sync watermark advances only on applied content, and the first socket open waits for auth resolution.

**Architecture:** No structural change — three invariant fixes inside the existing shapes. `WsClient` gets an honest `snapshotRequired` flag (set on request, cleared only when a snapshot arrives) and stops pre-advancing `opIdLastSeen` at `welcome` (it advances when the snapshot/ops actually arrive). `SyncSession` defers the first `wsClient.connect` behind `useAuth().ready` and makes the auth-reconnect watcher a no-op while the socket has never connected — eliminating the boot-time guest-hello → auth-reconnect double handshake that armed the race.

**Tech Stack:** TypeScript, Vue 3 reactivity (`watch`), Vitest (existing `MockWebSocket` + `memoryStorage` harness in `WsClient.test.ts`, fake-WsClient factory in `SyncSession.test.ts`).

## Global Constraints

- Work ONLY on branch `fix/p0-reload-snapshot-race`. Never commit to `main`.
- Stage ONLY the files you changed, by name. NEVER `git add -A`/`-u`. NEVER stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png` (untracked scratch in the repo root).
- Every commit message ends with these two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir`
- Gate (must pass before any commit): `npm run -w @fiddle/client typecheck && npm run -w @fiddle/client test -- --run`
- Local browser testing (controller does this after all tasks, not the task subagents): `npm run dev:obs` ONLY — NEVER `npm run dev` (it points at the real prod database).
- The wire protocol is untouched: no changes under `packages/shared/` or `packages/server/`. `resumeFromOpId` stays `z.number().int().nonnegative().optional()`.

## Background (read before Task 1)

Boot with a room URL: `connectToSession` loads a blank placeholder project, then `SyncSession.connect` opens socket A with `{forceSnapshot: true}` — a guest hello (Supabase auth hasn't resolved yet), no `resumeFromOpId`, server prepares a snapshot. Milliseconds later `supabase.auth.getSession()` resolves, the auth watcher fires `wsClient.reconnect()`, and three bugs line up:

1. `connect()` runs `this.forceSnapshotNextHello = opts?.forceSnapshot ?? false` — the bare reconnect **clears the flag**.
2. Socket A's `welcome` handler already persisted `opIdLastSeen = msg.opIdHead` — the watermark recorded a **promise**, not applied content.
3. Socket B's hello therefore resumes **from head**; the server replays nothing, sends `sync.complete`, and the outbound gate opens over the blank placeholder. Edits then sync UP and clobber room data.

The three tasks below fix (1), (2), and the boot-time double handshake respectively. Each is independently correct; together the race is gone and the class is dead.

---

### Task 1: `WsClient` — snapshot-required persists until a snapshot arrives

**Files:**
- Modify: `packages/client/src/sync/WsClient.ts` (field ~line 80-86, `connect()` ~line 100-103, `onSocketMessage` switch ~line 240-278)
- Test: `packages/client/src/sync/WsClient.test.ts`

**Interfaces:**
- Consumes: existing `WsClient.connect(opts?: { forceSnapshot?: boolean })`, existing `ServerMessage` union (the `snapshot` variant carries `opId: number` and `project`).
- Produces: renamed private field `snapshotRequired` (was `forceSnapshotNextHello`) with until-satisfied semantics, and a `case 'snapshot':` in `onSocketMessage`'s internal switch. Task 2 extends that same case.

- [ ] **Step 1: Rewrite the stale test and add the two new failing tests**

In `packages/client/src/sync/WsClient.test.ts`, **delete** the test `'resumes (does not force snapshot) on a plain auto-reconnect connect()'` (~line 161-177) — it codifies the buggy behavior (an unsatisfied forceSnapshot being dropped by a bare reconnect). Replace it, in the same spot, with these two tests:

```ts
  it('keeps forcing a snapshot across reconnects until one actually arrives (P0 reload-blank)', () => {
    // Boot race repro: forceSnapshot connect, welcome arrives, then the socket
    // is superseded (auth re-handshake) BEFORE the snapshot lands. The next
    // hello must still omit resumeFromOpId — resuming here would leave the
    // local placeholder in place and open the outbound gate over blank state.
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_old', opIdLastSeen: 42, clientSeq: 7 }),
    );
    const { client } = makeClient({ storage });
    client.connect({ forceSnapshot: true });
    const sockA = MockWebSocket.instances[0];
    sockA._open();
    sockA._msg(
      JSON.stringify({
        v: 1,
        type: 'welcome',
        clientId: 'c_old',
        color: '#fff',
        handle: 'kangaroo',
        opIdHead: 100,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        roster: [],
      }),
    );
    client.disconnect();
    client.connect(); // bare reconnect — no opts
    const sockB = MockWebSocket.instances.at(-1)!;
    sockB._open();
    const hello = JSON.parse(sockB.sent[0]);
    expect(hello.clientId).toBe('c_old');
    expect('resumeFromOpId' in hello).toBe(false);
  });

  it('resumes on a plain reconnect once the snapshot has arrived', () => {
    // The flag clears when the snapshot lands, so transient blips during a
    // stable session keep resuming (no gratuitous re-snapshots).
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_old', opIdLastSeen: 42, clientSeq: 7 }),
    );
    const { client } = makeClient({ storage });
    client.connect({ forceSnapshot: true });
    const sockA = MockWebSocket.instances[0];
    sockA._open();
    sockA._msg(
      JSON.stringify({
        v: 1,
        type: 'welcome',
        clientId: 'c_old',
        color: '#fff',
        handle: 'kangaroo',
        opIdHead: 100,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        roster: [],
      }),
    );
    sockA._msg(JSON.stringify({ v: 1, type: 'snapshot', opId: 100, project: {} }));
    client.disconnect();
    client.connect();
    const sockB = MockWebSocket.instances.at(-1)!;
    sockB._open();
    const hello = JSON.parse(sockB.sent[0]);
    expect(hello.resumeFromOpId).toBe(100);
  });
```

- [ ] **Step 2: Run the two new tests to verify they fail**

Run: `npm run -w @fiddle/client test -- --run src/sync/WsClient.test.ts`
Expected: the first new test FAILS (`hello` contains `resumeFromOpId` because the bare `connect()` cleared the flag). The second passes incidentally under the old code (welcome pre-advance) — that's fine; it pins the behavior Task 2 must preserve.

- [ ] **Step 3: Implement the flag-semantics fix in `WsClient.ts`**

Three edits.

(a) Replace the field declaration and its comment (currently ~lines 81-86):

```ts
  // When true, the next hello omits resumeFromOpId so the server replies with a
  // full snapshot instead of an op-replay delta. Set by a deliberate (re)entry
  // where the caller has reset local project state; a delta applied onto an
  // empty project would render the room blank. Cleared ONLY when a snapshot
  // actually arrives: needing a snapshot is a fact about local state, not about
  // any one connection attempt, so it must survive mid-handshake reconnects
  // (auth re-handshake, transient drop) until satisfied.
  private snapshotRequired = false;
```

(b) In `connect()`, replace `this.forceSnapshotNextHello = opts?.forceSnapshot ?? false;` with:

```ts
    // Only ever SET here — never clear. A reconnect between the request and the
    // snapshot's arrival must keep requesting one, or the new hello would resume
    // and leave the local placeholder in place (the reload-blank P0).
    if (opts?.forceSnapshot) this.snapshotRequired = true;
```

(c) In `sendHello()`, rename the flag read: `if (!this.snapshotRequired) {` (comment above it stays accurate). In `onSocketMessage()`'s switch, add a `snapshot` case (before `default`):

```ts
      case 'snapshot': {
        // The requested full snapshot is here — local state now holds room
        // content, so future hellos may resume again.
        this.snapshotRequired = false;
        break;
      }
```

There must be no remaining reference to `forceSnapshotNextHello` in the file.

- [ ] **Step 4: Run the WsClient suite, then the full gate**

Run: `npm run -w @fiddle/client test -- --run src/sync/WsClient.test.ts`
Expected: all tests PASS (including both new ones).
Run: `npm run -w @fiddle/client typecheck && npm run -w @fiddle/client test -- --run`
Expected: PASS, 0 type errors, no failures anywhere else.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/WsClient.ts packages/client/src/sync/WsClient.test.ts
git commit -m "fix(sync): snapshot-required flag persists across reconnects until a snapshot arrives

A bare reconnect() (auth re-handshake, auto-reconnect) used to reset
forceSnapshotNextHello, so a reconnect racing the initial snapshot sent a
resume hello and left the blank placeholder as live room state (P0
reload-blank, docs/BACKLOG.md). The flag is now set-only in connect() and
cleared exclusively when a snapshot message arrives.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 2: `WsClient` — the watermark advances only on applied content

**Files:**
- Modify: `packages/client/src/sync/WsClient.ts` (`welcome` case, `snapshot` case from Task 1, `sendHello()`)
- Test: `packages/client/src/sync/WsClient.test.ts`

**Interfaces:**
- Consumes: Task 1's `snapshotRequired` field and `case 'snapshot':` block; existing `recordOpIdSeen(opId)` (monotonic, no-ops when `getPersisted()` is null).
- Produces: `welcome` persists `opIdLastSeen: prev?.opIdLastSeen ?? -1` (never `msg.opIdHead`); the `snapshot` case additionally calls `this.recordOpIdSeen(msg.opId)`; `sendHello()` only includes `resumeFromOpId` when the watermark is `>= 0`.

- [ ] **Step 1: Update the stale welcome test and add three failing tests**

In `WsClient.test.ts`, rewrite the test `'persists clientId + opIdHead on welcome (resets clientSeq for new identity)'` (~line 202-226): rename it and change the expectation — the welcome frame is unchanged (`opIdHead: 100`) but the persisted record must now be:

```ts
  it('welcome persists clientId but NOT opIdHead — fresh identity starts at watermark -1', () => {
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
      opIdLastSeen: -1, // a promise of content is not applied content
      clientSeq: 0,
    });
  });
```

Then add these three tests:

```ts
  it('welcome preserves the applied watermark instead of adopting opIdHead', () => {
    // opIdLastSeen means "applied up to here". welcome's opIdHead is content
    // still in flight — recording it early made a mid-catch-up death resume
    // "from head" and skip the snapshot entirely (P0 reload-blank).
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_old', opIdLastSeen: 42, clientSeq: 7 }),
    );
    const { client } = makeClient({ storage });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    sock._msg(
      JSON.stringify({
        v: 1,
        type: 'welcome',
        clientId: 'c_old',
        color: '#fff',
        handle: 'kangaroo',
        opIdHead: 100,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        roster: [],
      }),
    );
    expect(JSON.parse(storage.getItem('fiddle:sync:room')!).opIdLastSeen).toBe(42);
  });

  it('snapshot advances the watermark to its opId', () => {
    const { client, storage } = makeClient();
    client.connect({ forceSnapshot: true });
    const sock = MockWebSocket.instances[0];
    sock._open();
    sock._msg(
      JSON.stringify({
        v: 1,
        type: 'welcome',
        clientId: 'c_new',
        color: '#fff',
        handle: 'kangaroo',
        opIdHead: 100,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        roster: [],
      }),
    );
    sock._msg(JSON.stringify({ v: 1, type: 'snapshot', opId: 100, project: {} }));
    expect(JSON.parse(storage.getItem('fiddle:sync:room')!).opIdLastSeen).toBe(100);
  });

  it('omits resumeFromOpId when the watermark is -1 (nothing applied yet)', () => {
    // The hello schema requires resumeFromOpId >= 0; sending -1 would be a
    // fatal validation error server-side. A -1 watermark means "never applied
    // anything" — a fresh join, which omitting the field already expresses.
    const storage = memoryStorage();
    storage.setItem(
      'fiddle:sync:room',
      JSON.stringify({ clientId: 'c_x', opIdLastSeen: -1, clientSeq: 0 }),
    );
    const { client } = makeClient({ storage });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock._open();
    const hello = JSON.parse(sock.sent[0]);
    expect(hello.clientId).toBe('c_x');
    expect('resumeFromOpId' in hello).toBe(false);
  });
```

- [ ] **Step 2: Run the WsClient suite to verify the new tests fail**

Run: `npm run -w @fiddle/client test -- --run src/sync/WsClient.test.ts`
Expected: the rewritten welcome test and the first, second, and fourth new tests FAIL (welcome still writes `opIdHead`; sendHello still sends `-1`). Task 1's `'resumes on a plain reconnect once the snapshot has arrived'` must still pass afterwards — it pins that the snapshot path takes over the watermark duty.

- [ ] **Step 3: Implement the watermark fix in `WsClient.ts`**

Three edits.

(a) In the `case 'welcome':` block, replace the `opIdLastSeen: msg.opIdHead,` line (and its surrounding `next` construction) with:

```ts
        const next: PersistedSyncState = {
          clientId: msg.clientId,
          // Carry the last APPLIED op forward — never adopt msg.opIdHead here.
          // The head is a promise of content to come; recording it before the
          // snapshot/replay arrives would make a connection that dies mid
          // catch-up resume "from head" and skip the content entirely (the P0
          // reload-blank bug). The watermark advances in the snapshot case
          // below and per-op via recordOpIdSeen.
          opIdLastSeen: prev?.opIdLastSeen ?? -1,
          // If clientId changed (fresh join OR unknown_client reissue), the
          // old clientSeq belongs to a different identity — start over.
          clientSeq: prev && prev.clientId === msg.clientId ? prev.clientSeq : 0,
        };
```

(b) In the `case 'snapshot':` block added in Task 1, add the watermark record after the flag clear:

```ts
      case 'snapshot': {
        // The requested full snapshot is here — local state now holds room
        // content, so future hellos may resume again.
        this.snapshotRequired = false;
        // The snapshot IS applied content up to its opId (dispatch applies it
        // synchronously right after this handler) — advance the watermark now,
        // replacing the welcome-time pre-advance.
        this.recordOpIdSeen(msg.opId);
        break;
      }
```

(c) In `sendHello()`, guard the resume field against the `-1` sentinel (schema requires nonnegative):

```ts
      if (!this.snapshotRequired && persisted.opIdLastSeen >= 0) {
        hello.resumeFromOpId = persisted.opIdLastSeen;
      }
```

Note: `case 'sync.complete':` already calls `this.recordOpIdSeen(msg.opId)` — leave it; it finalizes the op-replay path (every replayed op has been delivered by then) and is a monotonic no-op after a snapshot.

- [ ] **Step 4: Run the WsClient suite, then the full gate**

Run: `npm run -w @fiddle/client test -- --run src/sync/WsClient.test.ts`
Expected: all PASS.
Run: `npm run -w @fiddle/client typecheck && npm run -w @fiddle/client test -- --run`
Expected: PASS. If any other suite fails on welcome-persistence assumptions, fix the test's expectation to the new invariant (watermark only advances on snapshot/set/sync.complete) — do not re-add the pre-advance.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/WsClient.ts packages/client/src/sync/WsClient.test.ts
git commit -m "fix(sync): opIdLastSeen advances only on applied content, never at welcome

welcome persisted opIdLastSeen = opIdHead before any content arrived, so a
connection dying between welcome and snapshot resumed 'from head' and the
server correctly replayed nothing — the second half of the P0 reload-blank
bug. The watermark now carries forward at welcome, advances when the
snapshot arrives (new) and per-op (existing recordOpIdSeen), and sendHello
omits resumeFromOpId for the -1 never-applied sentinel (schema requires
nonnegative).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 3: `SyncSession` — first socket open waits for auth; auth watcher ignores pre-connect flips

**Files:**
- Modify: `packages/client/src/sync/SyncSession.ts` (`SyncAuth` interface ~line 27-30, `connect()` ~line 70-81, `installAuthReconnectWatcher()` ~line 168-179)
- Test: `packages/client/src/sync/SyncSession.test.ts`

**Interfaces:**
- Consumes: `useAuth()` already returns `ready: Promise<void>` (resolves after the initial `supabase.auth.getSession()` lands and the auth listener is wired; resolves immediately when supabase is unconfigured). `AppRuntime` wires `auth: () => useAuth()` — structural typing means no `AppRuntime` change.
- Produces: `SyncAuth` gains `ready: Promise<void>`; `SyncSession.connect(roomId)` still returns `void` but opens the socket asynchronously after `ready`; the auth watcher no-ops while `wsClient.state === 'closed'`.

- [ ] **Step 1: Update the fake auth + affected test, add four failing tests**

In `packages/client/src/sync/SyncSession.test.ts`:

(a) Line 48 — the fake auth gains `ready`:

```ts
    auth: () => ({ accessToken: ref(undefined), session: ref(null), ready: Promise.resolve() }),
```

(b) The test `'connect(roomId) builds+opens a socket, sets currentRoomId, raises roomLoading'` (~line 66): make it `async` and insert `await Promise.resolve();` between `session.connect('room-a');` and the `expect(built[0].connect)...` assertion (the socket now opens one microtask later, after `ready`). The `built`/`currentRoomId`/`roomLoading` assertions stay where they are — those are still synchronous.

(c) Add `state: 'closed' as string,` to the object returned by `makeFakeWsClient` (the watcher guard reads it; tests set it per-scenario).

(d) Add these four tests at the end of the `describe`:

```ts
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
```

Add `nextTick` to the vue import at the top: `import { ref, nextTick } from 'vue';`

- [ ] **Step 2: Run the SyncSession suite to verify the new tests fail**

Run: `npm run -w @fiddle/client test -- --run src/sync/SyncSession.test.ts`
Expected: FAIL — `SyncSessionDeps`' `SyncAuth` has no `ready` (typecheck) and/or `connect` is called synchronously in the first new test, and the pre-connect flip test sees `reconnect` called.

- [ ] **Step 3: Implement in `SyncSession.ts`**

Three edits.

(a) `SyncAuth` gains the promise:

```ts
export interface SyncAuth {
  accessToken: Ref<string | undefined>;
  session: Ref<{ user: { id: string } } | null>;
  // Resolves once the initial getSession + auth listener are wired. connect()
  // waits on this before the first hello so boot never handshakes as a guest
  // milliseconds before auth resolves (the double-handshake that armed the
  // reload-blank P0).
  ready: Promise<void>;
}
```

(b) In `connect()`, replace `this.wsClient!.connect({ forceSnapshot: true });` (and its comment) with:

```ts
    // Force a full snapshot: the caller reset the local project before connecting,
    // so a resume delta (op replay) would apply onto an empty project and leave
    // the room blank. forceSnapshot keeps our identity but pulls the whole room.
    //
    // Open only after auth has resolved: booting with a room URL used to send a
    // guest hello milliseconds before getSession() landed, and the auth watcher
    // then re-handshook mid-catch-up — the race behind the reload-blank P0. The
    // identity check below aborts if disconnect()/a newer connect() replaced
    // this connection while auth was resolving.
    const client = this.wsClient!;
    void this.deps.auth().ready.then(() => {
      if (this.wsClient === client) client.connect({ forceSnapshot: true });
    });
```

(c) In `installAuthReconnectWatcher()`, replace the watch callback body:

```ts
      (next, prev) => {
        if (next === prev) return;
        // A flip before the socket ever connected is boot-time getSession
        // resolution, not a login: the pending first hello reads the token
        // fresh (getToken), so there is nothing to re-derive. Only a socket
        // that has started its handshake carries a possibly-stale identity.
        const ws = this.wsClient;
        if (!ws || ws.state === 'closed') return;
        ws.reconnect();
      },
```

- [ ] **Step 4: Run the SyncSession suite, then the full gate**

Run: `npm run -w @fiddle/client test -- --run src/sync/SyncSession.test.ts`
Expected: all PASS.
Run: `npm run -w @fiddle/client typecheck && npm run -w @fiddle/client test -- --run`
Expected: PASS. If another suite (e.g. `AppRuntime.test.ts`, `synthContext.test.ts`) asserts a socket opened synchronously after `connect`, add the same one-microtask `await Promise.resolve()` — do not change production ordering.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/SyncSession.ts packages/client/src/sync/SyncSession.test.ts
git commit -m "fix(sync): defer first socket open until auth resolves; ignore pre-connect auth flips

Boot with a room URL sent a guest hello milliseconds before
supabase.auth.getSession() resolved; the auth watcher then bounced the
socket mid-catch-up — the double handshake that armed the reload-blank P0.
SyncSession.connect now waits on auth.ready (aborting if superseded), and
the auth-reconnect watcher no-ops while the socket has never connected,
since the pending hello reads the token fresh.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

### Task 4: Docs — BACKLOG resolution + ARCHITECTURE decision D18

**Files:**
- Modify: `docs/BACKLOG.md` (move the P0 entry from `## Open` to `## Resolved`)
- Modify: `docs/ARCHITECTURE.md` (append decision D18 after D17, ~line 638+)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1-3 (describe what IS, not what was planned).
- Produces: nothing downstream.

- [ ] **Step 1: Move the P0 entry in `docs/BACKLOG.md`**

Cut the entire `### 🔴 P0 — Reload of a session shows a blank default project (auth-reconnect races the initial snapshot)` section out of `## Open` and re-add it at the TOP of `## Resolved`, retitled `### P0 — Reload showed a blank default project (auth-reconnect raced the initial snapshot) — FIXED`. Keep the root-cause chain and evidence for the record, delete the "Proposed fix" subsection, and append this resolution note at the end of the section:

```markdown
**Resolution (2026-07-04, branch `fix/p0-reload-snapshot-race`):** three invariant fixes, no structural change — (1) `WsClient.snapshotRequired` (né `forceSnapshotNextHello`) is set-only in `connect()` and cleared exclusively when a snapshot arrives, so mid-handshake reconnects keep requesting the snapshot; (2) `welcome` no longer pre-advances `opIdLastSeen` to `opIdHead` — the watermark advances only on applied content (snapshot / per-op / sync.complete), and a `-1` never-applied sentinel is never sent as `resumeFromOpId`; (3) `SyncSession.connect` defers the first socket open behind `useAuth().ready` and the auth-reconnect watcher ignores flips while the socket has never connected, eliminating the boot-time double handshake. See ARCHITECTURE.md D18. The "Related hardening" item on the server re-minting `clientId` per authenticated hello remains open (cosmetic; tracked under the presence-roster-duplicates entry).
```

If the "Related hardening" bullets inside the entry mention the welcome pre-advance, delete that bullet (it is now fixed); keep the authenticated-identity re-mint one.

- [ ] **Step 2: Append D18 to `docs/ARCHITECTURE.md`**

After the `### D17 …` section, add:

```markdown
### D18 — Sync-catch-up invariants: watermark = applied content; snapshot-required until satisfied (2026-07-04)

Two invariants repaired after the reload-blank P0 (a signed-in reload showed a
fresh default project with the outbound gate open — edits could clobber room
data; the same mechanism most plausibly explains the June prod data-loss
incident):

- **`opIdLastSeen` records applied content, never a promise of it.** The
  `welcome` handler must not adopt the server's `opIdHead`; the watermark
  advances when content actually lands (the `snapshot` frame, each applied
  `set`, and `sync.complete` as the replay-path finalizer). Consequence: a
  connection that dies mid-catch-up resumes from what it truly applied, and
  the server replays the difference — correct by construction.
- **"I need a snapshot" is a fact about local state, not about a connection
  attempt.** `WsClient.snapshotRequired` is set when the caller has blanked the
  local project (room entry) and cleared only when a snapshot arrives. Any
  number of reconnects in between (auth re-handshake, transient drop) keep
  requesting a snapshot. A `connect()` call never clears it.

Supporting rule: the first socket open of a room connection waits on
`useAuth().ready`, and the auth-reconnect watcher ignores identity flips while
the socket has never connected (`state === 'closed'`) — the pending hello reads
the token fresh, so there is nothing to re-derive. This removes the boot-time
guest-hello → auth-reconnect double handshake rather than merely surviving it.
```

- [ ] **Step 3: Run the full gate**

Run: `npm run -w @fiddle/client typecheck && npm run -w @fiddle/client test -- --run`
Expected: PASS (docs-only task; this is the pre-commit gate).

- [ ] **Step 4: Commit**

```bash
git add docs/BACKLOG.md docs/ARCHITECTURE.md
git commit -m "docs: resolve P0 reload-blank in BACKLOG; add ARCHITECTURE D18 sync-catch-up invariants

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

## Post-plan verification (controller, not a task)

After all tasks + final review: browser-verify on `npm run dev:obs` (NEVER `npm run dev`). Guest flow: create a session, add steps/change bpm, hard-reload — content must restore (this exercises Tasks 1-2's snapshot/watermark path even without auth). Check the console is clean and only ONE "client live" handshake appears in the server log per page load. The signed-in reload repro (the actual 75% P0) requires Google OAuth, which is not automatable — flag it for the user's sign-off. Close all tabs when done.
