# Phase 5 — AppRuntime + Command-Stream Params + useSynth Dissolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the lifecycle redesign: a long-lived CommandBus as the sole gateway to state (emitting an applied-command stream), AudioEngine subscribing to that stream (watchers deleted), an AppRuntime composition root wiring every lifecycle event (pagehide + the single HMR hook), a per-page `project`, and `useSynth.ts` deleted behind a preserved `SYNTH_CONTEXT` surface.

**Architecture:** Five dependency-ordered tasks. Tasks 1–2 route every remaining writer (pre-connect fallback, nack rollback, snapshot, bulk ops, Open/New) through the bus so Task 3 can safely delete the audio watchers. Task 4 is the atomic swap that creates `AppRuntime`/`createSynthContext` and deletes `useSynth.ts`. Task 5 updates the architecture docs. Spec: `docs/superpowers/specs/2026-07-02-phase5-appruntime-design.md` (read it for rationale; this plan is self-contained for execution).

**Tech Stack:** Vue 3 + Pinia (setup stores), TypeScript, Vitest, Web Audio API, WebSocket sync.

## Global Constraints

- Branch: `feat/phase5-appruntime`. NEVER commit on `main`.
- Stage ONLY files you name. NEVER `git add -A`/`git add .`. NEVER stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`, `studio-rack.png`.
- Every commit message ends with these two lines:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir`
- Full gate = `npm run -w @fiddle/client typecheck && npm run -w @fiddle/server typecheck && npm run -w @fiddle/shared typecheck && npm run -w @fiddle/client test -- --run` (run server/shared suites too when their packages are touched; this plan never touches them).
- No `.vue` files are mounted in unit tests (project rule). Composables under test run via plain function calls with injected fakes.
- The sync accept-list forbids whole-object writes: every outbound/dispatched op is a **leaf** op (scalar at a path). Nested objects are drilled one level; the synth2 `matrix` array is drilled per-slot per-field.
- **Bus stream constraint:** subscribers must never dispatch (no re-entrant writes from a listener). Audio's handler only touches audio nodes.
- Emit ordering in the bus: `applySet` → `emit` → `enqueue` (audio reacts synchronously with the write, exactly as `flush:'sync'` did; outbound follows).
- Behavior parity is the default; the only sanctioned changes are the spec's called-out consequences (nested-param superset apply; whole matrix on slot edit; nack/reassert now reach audio; pagehide teardown on bfcache-freeze).
- Local dev/browser checks use `npm run dev:obs` (LOCAL Docker DB) — NEVER `npm run dev` (real prod Supabase). Browser verification is run by the controller after Tasks 3 and 4, not by task implementers.

---

## File map (who owns what by the end)

| File | Role |
|---|---|
| `packages/client/src/project/appliedCommand.ts` (NEW, T1) | `AppliedCommand` event type — neutral leaf so AudioEngine never imports from `sync/` |
| `packages/client/src/sync/CommandBus.ts` (T1) | THE single state gateway: 4 write methods + `subscribe` stream |
| `packages/client/src/sync/SyncSession.ts` (T1) | takes the long-lived bus as a dep; loses `project` dep and `dispatchLocal`; nack → `bus.applyRollback` |
| `packages/client/src/sync/messageDispatch.ts` (T1) | snapshot → `bus.loadProject(normalizeProject(...))`; loses `project` dep |
| `packages/client/src/sync/dispatchPolicy.ts` (NEW, T2) | `DISCRETE_LEAF_FIELDS` + `gestureEndForLeaf` (moved from useSynth) |
| `packages/client/src/project/mutations.ts` (T2) | pure draft producers: `clearTrackDraft`/`shiftTrackDraft`/`fillTrackDraft` |
| `packages/client/src/project/preset.ts` (T2) | adds `applyPresetDraft`/`resetEnginePatchDraft`; deletes mutating `applyPreset`/`resetEnginePatch` |
| `packages/client/src/project/paramDiff.ts` (T2) | gains `cloneEngineSlice` (moved from useSynth) |
| `packages/client/src/app/projectOps.ts` (NEW, T2) | bulk ops as draft-diff-dispatch: clear/shift/fill/applyPreset/initPatch/newProject/openProject |
| `packages/client/src/audio/AudioEngine.ts` (T3) | watchers/effectScope/diffParams DELETED → command-stream subscription |
| `packages/client/src/app/AppRuntime.ts` (NEW, T4) | `createAppRuntime(opts)` + `RUNTIME_KEY`; the only resource creator; `shutdown()` |
| `packages/client/src/app/synthContext.ts` (NEW, T4) | `createSynthContext(runtime)` + `SYNTH_CONTEXT` (moved from `sync/synthContext.ts`) |
| `packages/client/src/stores/project.ts` (T4) | `project` created INSIDE the setup store (per-Pinia); raw export + `__resetProjectStoreForTest` deleted |
| `packages/client/src/main.ts` (T4) | the single lifecycle file: bootstrap + `pagehide` + `import.meta.hot.dispose` |
| `packages/client/src/composables/useSynth.ts` | DELETED in T4 |
| `docs/ARCHITECTURE.md` (T5) | module map / data flow / lifecycle rewrite + D17; D8/D10 superseded, D13/D14 revised |

---

### Task 1: CommandBus grows up — stream, rollback, loadProject, long-lived

**Files:**
- Create: `packages/client/src/project/appliedCommand.ts`
- Modify: `packages/client/src/sync/CommandBus.ts`, `packages/client/src/sync/SyncSession.ts`, `packages/client/src/sync/messageDispatch.ts`, `packages/client/src/composables/useSynth.ts`
- Test: `packages/client/src/sync/CommandBus.test.ts` (extend), `packages/client/src/sync/SyncSession.test.ts` (harness update), `packages/client/src/sync/messageDispatch.test.ts` (deps update)

**Interfaces:**
- Consumes: `store`-equivalent primitives (`setDeep`/`replaceProject` on the module-scope `project` — Task 4 re-points these at the Pinia store), `SyncSession.enqueue` (existing, gated on `isSyncLive`).
- Produces (later tasks rely on these exact names):
  - `type AppliedCommand = { kind: 'set'; path: Path; value: unknown } | { kind: 'replace' }` from `../project/appliedCommand`
  - `CommandBus` gains: `applyRollback(path: Path, value: unknown): void`, `loadProject(next: Project): void`, `subscribe(l: (cmd: AppliedCommand) => void): () => void`
  - `CommandBusDeps` gains: `loadProject: (next: Project) => void`
  - `SyncSessionDeps` becomes `{ bus: CommandBus; wsClientFactory: () => WsClientFactory; syncEnabled: () => boolean; auth: () => SyncAuth }` (loses `project`); `SyncSession.dispatchLocal` is DELETED
  - useSynth keeps exporting `dispatchLocal(path, value)` — now unconditionally through the bus (fallback dead)

- [ ] **Step 1: Create the event type (neutral leaf)**

`packages/client/src/project/appliedCommand.ts`:

```ts
// AppliedCommand — the event the CommandBus emits after every state write.
// Lives under project/ (not sync/) so AudioEngine can consume the type without
// importing from the sync layer (same neutral-leaf rationale as paramDiff.ts).
import type { Path } from '@fiddle/shared';

export type AppliedCommand =
  | { kind: 'set'; path: Path; value: unknown }
  // Wholesale replace (server snapshot / Open / New / room reset): subscribers
  // re-derive from full current state rather than replaying leaves.
  | { kind: 'replace' };

export type AppliedCommandListener = (cmd: AppliedCommand) => void;
```

- [ ] **Step 2: Write the failing bus tests**

Append to `packages/client/src/sync/CommandBus.test.ts` (its existing harness builds a bus with `applySet` writing into a local object via `setDeep` and `enqueue: vi.fn()` — extend the local `makeBus` helper, whatever it is named, to also accept/record `loadProject`, then add):

```ts
describe('applied-command stream (Phase 5)', () => {
  it('subscribe sees a set AFTER the state write, then enqueue runs', () => {
    const calls: string[] = [];
    const state: Record<string, unknown> = {};
    const bus = createCommandBus({
      applySet: (path, value) => { state[String(path[0])] = value; calls.push('applySet'); },
      loadProject: () => { calls.push('loadProject'); },
      enqueue: () => { calls.push('enqueue'); },
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => {
      calls.push('emit');
      seen.push(cmd);
      // state is already written when the listener runs:
      expect(state.bpm).toBe(140);
    });
    bus.dispatchLocal({ path: ['bpm'], value: 140 });
    expect(calls).toEqual(['applySet', 'emit', 'enqueue']);
    expect(seen).toEqual([{ kind: 'set', path: ['bpm'], value: 140 }]);
  });

  it('applyRemote emits on apply, and does NOT emit on a stale watermark drop', () => {
    const state: Record<string, unknown> = {};
    const bus = createCommandBus({
      applySet: (path, value) => { state[String(path[0])] = value; },
      loadProject: () => {},
      enqueue: () => {},
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => seen.push(cmd));
    bus.applyRemote({ v: 1, type: 'set', opId: 5, path: ['bpm'], value: 130, clientId: 'x' } as never);
    bus.applyRemote({ v: 1, type: 'set', opId: 4, path: ['bpm'], value: 99, clientId: 'x' } as never); // stale
    expect(seen).toHaveLength(1);
  });

  it('applyRemote does NOT emit when applySet throws', () => {
    const bus = createCommandBus({
      applySet: () => { throw new Error('bad path'); },
      loadProject: () => {},
      enqueue: () => {},
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => seen.push(cmd));
    expect(bus.applyRemote({ v: 1, type: 'set', opId: 1, path: ['nope'], value: 1, clientId: 'x' } as never)).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('applyRollback writes + emits and never enqueues', () => {
    const state: Record<string, unknown> = {};
    const enqueue = vi.fn();
    const bus = createCommandBus({
      applySet: (path, value) => { state[String(path[0])] = value; },
      loadProject: () => {},
      enqueue,
    });
    const seen: unknown[] = [];
    bus.subscribe((cmd) => seen.push(cmd));
    bus.applyRollback(['bpm'], 120);
    expect(state.bpm).toBe(120);
    expect(seen).toEqual([{ kind: 'set', path: ['bpm'], value: 120 }]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('loadProject calls deps.loadProject then emits a replace event', () => {
    const calls: string[] = [];
    const bus = createCommandBus({
      applySet: () => {},
      loadProject: () => { calls.push('loadProject'); },
      enqueue: () => {},
    });
    bus.subscribe((cmd) => { calls.push(cmd.kind); });
    bus.loadProject({} as never);
    expect(calls).toEqual(['loadProject', 'replace']);
  });

  it('unsubscribe stops delivery', () => {
    const bus = createCommandBus({ applySet: () => {}, loadProject: () => {}, enqueue: () => {} });
    const seen: unknown[] = [];
    const unsub = bus.subscribe((cmd) => seen.push(cmd));
    bus.dispatchLocal({ path: ['bpm'], value: 1 });
    unsub();
    bus.dispatchLocal({ path: ['bpm'], value: 2 });
    expect(seen).toHaveLength(1);
  });
});
```

Note: every EXISTING bus construction in this test file must gain the new required `loadProject` dep — add `loadProject: () => {}` to the existing helper.

- [ ] **Step 3: Run to verify failure**

Run: `npm run -w @fiddle/client test -- --run src/sync/CommandBus.test.ts`
Expected: FAIL — `subscribe is not a function` / missing `loadProject` dep type errors.

- [ ] **Step 4: Implement the new CommandBus**

Replace the body of `packages/client/src/sync/CommandBus.ts` (keep the existing header comment, updating its second paragraph to say the bus is now long-lived — created once by the app root, `resetWatermark()` called per connect — and emits an applied-command stream consumed by AudioEngine):

```ts
import { pathKey, type Path, type Project, type SetOpBroadcast } from '@fiddle/shared';
import type { AppliedCommand, AppliedCommandListener } from '../project/appliedCommand';

export interface CommandBusDeps {
  /** Write `value` at `path` into canonical project state (ProjectStore.applySet). */
  applySet: (path: Path, value: unknown) => void;
  /** Replace the whole project in place (snapshot / Open / New / room reset). */
  loadProject: (next: Project) => void;
  /** Hand an outbound op to the Outbox (throttle/coalesce/nack). Gated on the room being live by the provider. */
  enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => void;
}

export interface LocalCommand {
  path: Path;
  value: unknown;
  /** Pre-edit value, carried to the Outbox for nack rollback. */
  priorValue?: unknown;
  /** Discrete action (select/toggle/mouseup) — flush immediately past the throttle. */
  gestureEnd?: boolean;
}

export function createCommandBus(deps: CommandBusDeps) {
  const lastAppliedOpIdForPath = new Map<string, number>();

  // Applied-command stream: emitted synchronously AFTER each state write and
  // BEFORE the outbound enqueue — the same ordering the flush:'sync' audio
  // watchers had. Subscribers must never dispatch (no re-entrant writes).
  const listeners = new Set<AppliedCommandListener>();
  function emit(cmd: AppliedCommand): void {
    for (const l of listeners) l(cmd);
  }
  function subscribe(l: AppliedCommandListener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  }

  function dispatchLocal(cmd: LocalCommand): void {
    deps.applySet(cmd.path, cmd.value);
    emit({ kind: 'set', path: cmd.path, value: cmd.value });
    deps.enqueue(cmd.path, cmd.value, cmd.priorValue, cmd.gestureEnd ?? false);
  }

  function applyRemote(op: SetOpBroadcast): boolean {
    const key = pathKey(op.path);
    const prev = lastAppliedOpIdForPath.get(key) ?? -1;
    if (op.opId <= prev) return false; // stale / duplicate — ignore
    lastAppliedOpIdForPath.set(key, op.opId);
    try {
      deps.applySet(op.path, op.value);
    } catch (err) {
      console.warn('applyRemote: dropped op with unresolvable path', op.path, err);
      return false;
    }
    emit({ kind: 'set', path: op.path, value: op.value });
    return true;
  }

  // State-only write + emit: nack rollback and reassert-pending restores.
  // No enqueue (never re-sends), no watermark (not a broadcast op).
  function applyRollback(path: Path, value: unknown): void {
    deps.applySet(path, value);
    emit({ kind: 'set', path, value });
  }

  // Wholesale replace + one replace event (subscribers re-derive from state).
  function loadProject(next: Project): void {
    deps.loadProject(next);
    emit({ kind: 'replace' });
  }

  function resetWatermark(): void {
    lastAppliedOpIdForPath.clear();
  }

  function advanceWatermark(path: Path, opId: number): boolean {
    const key = pathKey(path);
    const prev = lastAppliedOpIdForPath.get(key) ?? -1;
    if (opId <= prev) return false;
    lastAppliedOpIdForPath.set(key, opId);
    return true;
  }

  return { dispatchLocal, applyRemote, applyRollback, loadProject, subscribe, advanceWatermark, resetWatermark };
}

export type CommandBus = ReturnType<typeof createCommandBus>;
```

(Keep the existing doc comments on `advanceWatermark`/`resetWatermark` — shown compressed here.)

- [ ] **Step 5: Make SyncSession consume the long-lived bus**

In `packages/client/src/sync/SyncSession.ts`:

1. `SyncSessionDeps`: delete `project: Project;` add `bus: CommandBus;`. Delete the now-unused `import { setDeep } ...` and `Project` type import; delete `createCommandBus` from the CommandBus import (keep `type CommandBus`, drop `type LocalCommand`).
2. Delete the field `private commandBus: CommandBus | null = null;` and the line `this.commandBus = null;` in `disconnect()`.
3. Delete the whole `dispatchLocal(cmd: LocalCommand): boolean` method (callers go straight to the bus).
4. In `buildConnection(roomId)`: first line becomes `this.syncReady = false; this.deps.bus.resetWatermark();` (fresh room = fresh watermark — replaces the fresh-bus-per-connection behavior). Delete `const project = this.deps.project;`.
5. The `dispatchServerMessage` deps object: delete `project`, and pass `commandBus: this.deps.bus`.
6. The Outbox construction: replace the `applyLocal` closure with:

```ts
      applyLocal: (path: Path, value: unknown) => {
        // Rollback / reassert write: route through the bus so state AND the
        // audio stream see the restored value (state-only — never re-sends).
        this.deps.bus.applyRollback(path, value);
      },
```

7. Delete the whole trailing `this.commandBus = createCommandBus({...})` block.

- [ ] **Step 6: messageDispatch — snapshot through the bus**

In `packages/client/src/sync/messageDispatch.ts`:

1. `DispatchDeps`: delete `project: Project;`. Delete the `Project` type import and the `replaceProject` import.
2. The `snapshot` case becomes:

```ts
    case 'snapshot':
      // Normalize first so a snapshot from an older (pre-pool) server can't
      // under-fill the fixed 32-slot model or leave an out-of-range bpm.
      // Routed through the bus so the audio stream gets one `replace` event.
      deps.commandBus.loadProject(normalizeProject(msg.project));
      deps.commandBus.resetWatermark();
      deps.outbox.reassertPending();
      return;
```

- [ ] **Step 7: useSynth — construct the bus, kill the fallback**

In `packages/client/src/composables/useSynth.ts`:

1. Add `import { createCommandBus } from '../sync/CommandBus';` (the `SyncSession` import stays).
2. ABOVE the `const session = new SyncSession({...})` block, add (the arrow in `enqueue` makes the bus↔session circularity safe — it only runs after both consts exist):

```ts
// The one command bus for this tab — THE single gateway to project state.
// Long-lived (survives room switches; SyncSession resets its watermark per
// connect). applySet/loadProject write the canonical project; enqueue hands
// outbound ops to the session, which gates on the room being live.
const bus = createCommandBus({
  applySet: (path, value) => {
    setDeep(project as unknown as Record<string, unknown>, path, value);
  },
  loadProject: (next) => {
    replaceProject(project, next);
  },
  enqueue: (path, value, priorValue, gestureEnd) => {
    session.enqueue(path, value, priorValue, gestureEnd);
  },
});
```

3. Update the `SyncSession` construction: remove `project,`; add `bus,`.
4. Rewrite `dispatchLocal` (the fallback dies — the bus always writes; outbound is gated inside `session.enqueue`):

```ts
// The single outbound entry point for a LOCAL edit. Always routes through the
// command bus: the bus writes state + emits to the audio stream; the outbound
// enqueue is gated on the room being live inside session.enqueue, so
// pre-connect edits still drive audio + UI without trying to sync.
export function dispatchLocal(path: Path, value: unknown): void {
  const gestureEnd = gestureEndForLeaf(String(path[path.length - 1]));
  const priorValue = getDeep(project as unknown as Record<string, unknown>, path);
  bus.dispatchLocal({ path, value, priorValue, gestureEnd });
}
```

5. Rewrite `resetLocalProject` body: `bus.loadProject(freshProject());` (delete the `replaceProject(project, freshProject())` line; `replaceProject` stays imported — the bus dep uses it).

- [ ] **Step 8: Update the two sync test harnesses**

`packages/client/src/sync/SyncSession.test.ts` — the `makeSession` helper becomes (imports gain `createCommandBus` from `./CommandBus`, `replaceProject` from `../project`, `setDeep` from `@fiddle/shared`):

```ts
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
    auth: () => ({ accessToken: ref(undefined), session: ref(null) }),
    ...overrides,
  };
  session = new SyncSession(deps);
  return { session, built, project, bus };
}
```

Then fix the tests: any test using `session.dispatchLocal(...)` is rewritten against the bus — replace the `'dispatchLocal writes state + enqueues when live; returns false when disconnected'` test with:

```ts
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
```

Any test that referenced `deps.project`/passed `project` in overrides now uses the returned `project`. Add one new test pinning the watermark reset:

```ts
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
```

`packages/client/src/sync/messageDispatch.test.ts` — the `deps(project)` helper drops the `project` field and its bus gains the new dep (import `replaceProject` from `../project`):

```ts
function deps(project: Project): DispatchDeps {
  return {
    wsClient: { recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn() } as unknown as DispatchDeps['wsClient'],
    outbox: {
      onLive: vi.fn(), onEcho: vi.fn(), onNack: vi.fn(), reassertPending: vi.fn(),
      hasPendingForPath: vi.fn(() => false),
    } as unknown as DispatchDeps['outbox'],
    onFatalError: vi.fn(),
    commandBus: createCommandBus({
      applySet: (path, value) => setDeep(project as unknown as Record<string, unknown>, path, value),
      loadProject: (next) => replaceProject(project, next),
      enqueue: vi.fn(),
    }),
  };
}
```

The snapshot tests keep passing unchanged (loadProject → normalize + replaceProject is the same write).

- [ ] **Step 9: Full gate**

Run the full gate (Global Constraints). Expected: all green — `useSynth.test.ts` passes untouched (pre-connect dispatch, nack rollback, and snapshot flows are byte-equivalent through the new routes). If a `useSynth.test.ts` test fails, the routing changed behavior — fix the routing, not the test.

- [ ] **Step 10: Commit**

```bash
git add packages/client/src/project/appliedCommand.ts packages/client/src/sync/CommandBus.ts packages/client/src/sync/CommandBus.test.ts packages/client/src/sync/SyncSession.ts packages/client/src/sync/SyncSession.test.ts packages/client/src/sync/messageDispatch.ts packages/client/src/sync/messageDispatch.test.ts packages/client/src/composables/useSynth.ts
git commit -m "feat(sync): long-lived CommandBus with applied-command stream (phase 5 task 1)"
```

---

### Task 2: Bulk ops → pure draft-diff-dispatch (`projectOps`)

**Files:**
- Create: `packages/client/src/sync/dispatchPolicy.ts`, `packages/client/src/app/projectOps.ts`
- Modify: `packages/client/src/project/mutations.ts`, `packages/client/src/project/preset.ts`, `packages/client/src/project/paramDiff.ts`, `packages/client/src/project/index.ts`, `packages/client/src/composables/useSynth.ts`, `packages/client/src/views/StudioView.vue`
- Test: `packages/client/src/app/projectOps.test.ts` (new), `packages/client/src/composables/useSynth.test.ts` (delete superseded emitter tests), plus any existing `mutations`/`preset` tests (`grep -rln "clearTrack\|applyPreset(" packages/client/src --include='*.test.ts'` and port them to the draft API)

**Interfaces:**
- Consumes (Task 1): `bus.dispatchLocal(cmd)`, `bus.loadProject(next)`, `session.isSyncLive`, `session.enqueue(path, value, prior, gestureEnd)`.
- Produces:
  - `gestureEndForLeaf(leafKey: string): boolean` + `DISCRETE_LEAF_FIELDS` from `sync/dispatchPolicy`
  - `cloneEngineSlice(src: Record<string, unknown>): Record<string, unknown>` from `project/paramDiff`
  - `clearTrackDraft(patternLength: number): Step[]`, `shiftTrackDraft(steps: readonly Step[], direction: 'left'|'right', patternLength: number): Step[]`, `fillTrackDraft(steps: readonly Step[], interval: number, patternLength: number): Step[]` from `project/mutations`
  - `applyPresetDraft(track: ProjectTrack, preset: Preset): Record<string, unknown>`, `resetEnginePatchDraft(track: ProjectTrack): Record<string, unknown>` from `project/preset`
  - `createProjectOps(deps: ProjectOpsDeps)` returning `{ clearTrack(trackId), shiftTrack(trackId, direction), fillTrack(trackId, interval), applyPreset(trackId, preset), initPatch(trackId), newProject(), openProject(loaded) }` from `app/projectOps`
  - useSynth exports `projectOps` (interim; Task 4 moves it onto the context)

- [ ] **Step 1: Extract the gesture policy**

`packages/client/src/sync/dispatchPolicy.ts` — move `DISCRETE_LEAF_FIELDS` and `gestureEndForLeaf` VERBATIM from `useSynth.ts` (including every per-field comment), exporting both. In `useSynth.ts` delete them and add `import { gestureEndForLeaf } from '../sync/dispatchPolicy';`.

- [ ] **Step 2: Move `cloneEngineSlice`**

Append to `packages/client/src/project/paramDiff.ts` (verbatim body from useSynth.ts, exported); delete it (and its doc comment) from `useSynth.ts` and update the one import site in `StudioView.vue` later in this task (it disappears entirely there).

- [ ] **Step 3: Pure draft producers — mutations.ts**

Replace `packages/client/src/project/mutations.ts` entirely:

```ts
import type { Step } from '@fiddle/shared';
import { freshStep } from './factory';

// Pure draft producers (Phase 5): compute the post-op steps window WITHOUT
// mutating live state. The caller (app/projectOps) diffs draft vs live and
// dispatches each changed leaf through the CommandBus — the bus (via the
// store) is the only writer of project state.

export function clearTrackDraft(patternLength: number): Step[] {
  return Array.from({ length: patternLength }, () => freshStep());
}

export function shiftTrackDraft(
  steps: readonly Step[],
  direction: 'left' | 'right',
  patternLength: number,
): Step[] {
  const window = steps.slice(0, patternLength).map((s) => ({ ...s }));
  if (patternLength <= 1) return window;
  return window.map((_, i) =>
    direction === 'left'
      ? { ...window[(i + 1) % patternLength] }
      : { ...window[(i - 1 + patternLength) % patternLength] },
  );
}

export function fillTrackDraft(
  steps: readonly Step[],
  interval: number,
  patternLength: number,
): Step[] {
  const window = steps.slice(0, patternLength).map((s) => ({ ...s }));
  if (interval <= 0) return window; // guard against modulo-by-zero (UI only offers 1/2/4/8)
  for (let i = 0; i < patternLength; i++) {
    if (i % interval === 0) {
      Object.assign(window[i], { note: 'C', muted: false, velocity: 0.8, isChord: false, chordType: 'maj' });
    }
  }
  return window;
}
```

Update `project/index.ts`: `export { clearTrackDraft, shiftTrackDraft, fillTrackDraft } from './mutations';` (replacing the old three names).

- [ ] **Step 4: Draft producers — preset.ts**

In `packages/client/src/project/preset.ts`, DELETE `applyPreset` and `resetEnginePatch` and add (import `cloneEngineSlice` from `./paramDiff`):

```ts
// Compute the engine slice a preset load would produce — a plain draft, no
// mutation. Mirrors the old applyPreset semantics: preset params are assigned
// over a clone of the live slice (whole nested objects replaced by assign).
// engineType is NOT part of the draft — the caller dispatches it separately
// (discrete op, correct prior = the OLD engine).
export function applyPresetDraft(track: ProjectTrack, preset: Preset): Record<string, unknown> {
  const live = track.engines[preset.engineType] as unknown as Record<string, unknown>;
  const draft = cloneEngineSlice(live);
  Object.assign(draft, preset.params as unknown as Record<string, unknown>);
  return draft;
}

// Draft for INIT PATCH: the active engine's DEFAULT_PARAMS over a clone of the
// live slice. structuredClone is safe — DEFAULTS are static plain objects.
export function resetEnginePatchDraft(track: ProjectTrack): Record<string, unknown> {
  const live = track.engines[track.engineType] as unknown as Record<string, unknown>;
  const draft = cloneEngineSlice(live);
  Object.assign(draft, structuredClone(DEFAULTS[track.engineType]) as unknown as Record<string, unknown>);
  return draft;
}
```

Update `project/index.ts`: export `applyPresetDraft`, `resetEnginePatchDraft`; remove `applyPreset`, `resetEnginePatch`.

- [ ] **Step 5: Write the failing projectOps tests**

`packages/client/src/app/projectOps.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { reactive } from 'vue';
import { setDeep, type Path } from '@fiddle/shared';
import { freshProject, replaceProject, type Project } from '../project';
import { createProjectOps } from './projectOps';

// Fake bus: records dispatches AND actually writes (so live state advances the
// way the real bus's applySet does, and priors can be asserted against it).
function makeHarness(syncLive = true) {
  const project = reactive(freshProject()) as Project;
  const dispatched: { path: Path; value: unknown; priorValue: unknown; gestureEnd: boolean }[] = [];
  const enqueued: { path: Path; value: unknown; prior: unknown; gestureEnd: boolean }[] = [];
  const loadProjectSpy = vi.fn((next: Project) => replaceProject(project, next));
  const bus = {
    dispatchLocal(cmd: { path: Path; value: unknown; priorValue?: unknown; gestureEnd?: boolean }) {
      dispatched.push({ path: cmd.path, value: cmd.value, priorValue: cmd.priorValue, gestureEnd: cmd.gestureEnd ?? false });
      setDeep(project as unknown as Record<string, unknown>, cmd.path, cmd.value);
    },
    loadProject: loadProjectSpy,
  };
  const ops = createProjectOps({
    project,
    bus,
    isSyncLive: () => syncLive,
    enqueue: (path, value, prior, gestureEnd) => enqueued.push({ path, value, prior, gestureEnd }),
  });
  return { project, ops, dispatched, enqueued, loadProjectSpy };
}

describe('projectOps — steps window (Clear / Shift / Fill)', () => {
  it('clearTrack dispatches only the non-fresh leaves, with live priors, and writes state', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].steps[0].note = 'D';
    project.tracks[0].steps[0].velocity = 0.5;
    ops.clearTrack(0);
    expect(dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['tracks', 0, 'steps', 0, 'note'], value: null, priorValue: 'D' }),
      expect.objectContaining({ path: ['tracks', 0, 'steps', 0, 'velocity'], value: 0.8, priorValue: 0.5 }),
    ]));
    expect(project.tracks[0].steps[0].note).toBeNull();
  });

  it('clearTrack on an already-fresh track dispatches nothing (C1 regression)', () => {
    const { ops, dispatched } = makeHarness();
    ops.clearTrack(0);
    expect(dispatched).toHaveLength(0);
  });

  it('clearTrack only touches the active window (steps beyond patternLength untouched)', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].patternLength = 4;
    project.tracks[0].steps[10].note = 'G';
    ops.clearTrack(0);
    expect(dispatched).toHaveLength(0);              // window 0..3 already fresh
    expect(project.tracks[0].steps[10].note).toBe('G');
  });

  it('shiftTrack left rotates the window via leaf dispatches', () => {
    const { project, ops } = makeHarness();
    project.tracks[0].patternLength = 4;
    project.tracks[0].steps[1].note = 'E';
    ops.shiftTrack(0, 'left');
    expect(project.tracks[0].steps[0].note).toBe('E');
    expect(project.tracks[0].steps[1].note).toBeNull();
  });

  it('fillTrack dispatches note/velocity/muted for the filled slots', () => {
    const { project, ops, dispatched } = makeHarness();
    project.tracks[0].patternLength = 4;
    ops.fillTrack(0, 2);
    expect(project.tracks[0].steps[0].note).toBe('C');
    expect(project.tracks[0].steps[2].note).toBe('C');
    expect(project.tracks[0].steps[1].note).toBeNull();
    expect(dispatched.some((d) => String(d.path[4]) === 'note' && d.value === 'C')).toBe(true);
  });
});

describe('projectOps — preset / init patch', () => {
  it('applyPreset dispatches engineType FIRST (discrete, old-engine prior), then only changed params', () => {
    const { project, ops, dispatched } = makeHarness();
    const defaultCutoff = project.tracks[0].engines.synth.filterCutoff;
    ops.applyPreset(0, {
      schemaVersion: 1,
      engineType: 'synth',
      params: { ...project.tracks[0].engines.synth, filterCutoff: 4242 },
    } as never);
    expect(dispatched[0]).toEqual(expect.objectContaining({
      path: ['tracks', 0, 'engineType'], value: 'synth', gestureEnd: true,
    }));
    const cutoffOp = dispatched.find((d) => String(d.path[4]) === 'filterCutoff');
    expect(cutoffOp).toEqual(expect.objectContaining({ value: 4242, priorValue: defaultCutoff }));
    // unchanged params produce no ops:
    expect(dispatched.filter((d) => d.path[2] === 'engines')).toHaveLength(1);
    expect(project.tracks[0].engines.synth.filterCutoff).toBe(4242);
  });

  it('applyPreset drills a synth2 matrix change to per-slot leaf ops (I3a)', () => {
    const { project, ops, dispatched } = makeHarness();
    const params = JSON.parse(JSON.stringify(project.tracks[0].engines.synth2));
    params.matrix = params.matrix.map((slot: Record<string, unknown>) => ({ ...slot }));
    params.matrix[0].amount = 0.77;
    ops.applyPreset(0, { schemaVersion: 1, engineType: 'synth2', params } as never);
    const matrixOps = dispatched.filter((d) => d.path[4] === 'matrix');
    expect(matrixOps).toEqual([expect.objectContaining({
      path: ['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'amount'], value: 0.77,
    })]);
    // never a whole-slot or whole-matrix write:
    expect(dispatched.some((d) => d.path[4] === 'matrix' && d.path.length < 7)).toBe(false);
  });

  it('initPatch dispatches the edited params back to defaults', () => {
    const { project, ops, dispatched } = makeHarness();
    const defaultCutoff = project.tracks[0].engines.synth.filterCutoff;
    project.tracks[0].engines.synth.filterCutoff = 9999;
    ops.initPatch(0);
    expect(dispatched).toEqual([expect.objectContaining({
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: defaultCutoff, priorValue: 9999,
    })]);
  });
});

describe('projectOps — whole-project (New / Open)', () => {
  it('newProject loads a fresh project and enqueues the outbound diff of prior edits (M3)', () => {
    const { project, ops, enqueued, loadProjectSpy } = makeHarness();
    project.bpm = 155;
    project.tracks[0].steps[0].note = 'A';
    ops.newProject();
    expect(loadProjectSpy).toHaveBeenCalledTimes(1);
    expect(project.bpm).not.toBe(155);
    expect(enqueued.some((e) => e.path[0] === 'bpm' && e.prior === 155)).toBe(true);
    expect(enqueued.some((e) => String(e.path[4]) === 'note' && e.prior === 'A')).toBe(true);
  });

  it('newProject when sync is not live loads WITHOUT enqueueing anything', () => {
    const { project, ops, enqueued, loadProjectSpy } = makeHarness(false);
    project.bpm = 155;
    ops.newProject();
    expect(loadProjectSpy).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(0);
  });

  it('openProject loads the given project and enqueues engine-param + matrix diffs (Open/New coverage)', () => {
    const { project, ops, enqueued } = makeHarness();
    const loaded = freshProject();
    loaded.tracks[0].engines.synth.filterCutoff = 1234;
    loaded.tracks[0].engines.synth2.matrix[0].amount = 0.42;
    ops.openProject(loaded);
    expect(project.tracks[0].engines.synth.filterCutoff).toBe(1234);
    expect(enqueued.some((e) => String(e.path[4]) === 'filterCutoff' && e.value === 1234)).toBe(true);
    expect(enqueued.some((e) => e.path[4] === 'matrix' && e.value === 0.42)).toBe(true);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npm run -w @fiddle/client test -- --run src/app/projectOps.test.ts`
Expected: FAIL — module `./projectOps` not found.

- [ ] **Step 7: Implement projectOps**

`packages/client/src/app/projectOps.ts`:

```ts
// projectOps — every bulk project operation as pure draft-diff-dispatch.
//
// Each op computes a DRAFT of the post-op state (the pure helpers in
// project/mutations + project/preset), diffs it against live state, and
// dispatches each changed leaf through the CommandBus — the bus performs the
// actual write (and the outbound enqueue, and the audio-stream emit). Nothing
// here mutates `project` directly, which is what makes "state has exactly one
// writer" literally true.
//
// Exception: New/Open replace the whole project via bus.loadProject (one
// `replace` audio event), then enqueue the outbound leaf diff of live-vs-before
// — identical wire behavior to the old syncWholeProjectDiff.

import { TRACK_POOL_SIZE, type Path, type Project } from '@fiddle/shared';
import type { EngineType, Preset } from '../project';
import {
  clearTrackDraft, shiftTrackDraft, fillTrackDraft,
  applyPresetDraft, resetEnginePatchDraft, freshProject,
} from '../project';
import { diffParams, cloneEngineSlice } from '../project/paramDiff';
import { gestureEndForLeaf } from '../sync/dispatchPolicy';

// Local copy of the engine-slice key list (same duplication as preset.ts /
// storage.ts / normalize.ts / AudioEngine.ts; DRY-ing them is a separate cleanup).
const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'];

export interface ProjectOpsDeps {
  project: Project;
  bus: {
    dispatchLocal(cmd: { path: Path; value: unknown; priorValue?: unknown; gestureEnd?: boolean }): void;
    loadProject(next: Project): void;
  };
  /** Outbound gate — mirrors the old emitters' `isSyncLive` guard. */
  isSyncLive: () => boolean;
  /** Outbound-only enqueue for the whole-project (New/Open) diff. */
  enqueue: (path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean) => void;
}

export interface ProjectSyncSnapshot {
  bpm: number;
  tracks: {
    engineType: string; patternLength: number; enabled: boolean;
    mixer: Record<string, unknown>;
    steps: Record<string, unknown>[];
    engines: Record<string, Record<string, unknown>>;
  }[];
}

export function createProjectOps(deps: ProjectOpsDeps) {
  const { project, bus } = deps;

  const dispatch = (path: Path, value: unknown, priorValue: unknown): void => {
    bus.dispatchLocal({ path, value, priorValue, gestureEnd: gestureEndForLeaf(String(path[path.length - 1])) });
  };

  // Diff draft vs live at `prefix` and dispatch each changed leaf. Nested
  // objects are drilled one level (the accept-list forbids whole-object
  // writes); arrays (synth2.matrix) are skipped here and drilled per-slot by
  // dispatchMatrixDiff. Priors come from live (pre-write) state.
  function dispatchDiff(
    prefix: Path,
    draft: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void {
    const changed = diffParams(draft, live);
    if (!changed) return;
    for (const [key, value] of Object.entries(changed)) {
      if (Array.isArray(value)) continue;
      if (value !== null && typeof value === 'object') {
        const liveNested = (live[key] ?? {}) as Record<string, unknown>;
        const draftNested = value as Record<string, unknown>;
        for (const subKey of Object.keys(draftNested)) {
          if (liveNested[subKey] === draftNested[subKey]) continue;
          dispatch([...prefix, key, subKey], draftNested[subKey], liveNested[subKey]);
        }
      } else {
        dispatch([...prefix, key], value, live[key]);
      }
    }
  }

  // synth2 mod matrix: per-slot per-field leaf dispatches (arrays are skipped
  // by dispatchDiff so a whole-slot object write can never be emitted).
  function dispatchMatrixDiff(
    trackIdx: number,
    draft: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void {
    const draftM = (draft as { matrix?: Record<string, unknown>[] }).matrix;
    const liveM = (live as { matrix?: Record<string, unknown>[] }).matrix;
    if (!draftM || !liveM) return;
    for (let s = 0; s < draftM.length; s++) {
      for (const field of ['source', 'dest', 'amount'] as const) {
        const d = draftM[s]?.[field]; const l = liveM[s]?.[field];
        if (d === l) continue;
        dispatch(['tracks', trackIdx, 'engines', 'synth2', 'matrix', s, field], d, l);
      }
    }
  }

  function dispatchStepsWindow(trackId: number, draft: readonly Record<string, unknown>[]): void {
    const live = project.tracks[trackId].steps;
    for (let j = 0; j < draft.length; j++) {
      dispatchDiff(
        ['tracks', trackId, 'steps', j],
        draft[j],
        live[j] as unknown as Record<string, unknown>,
      );
    }
  }

  // ---- whole-project outbound diff (New/Open) — moved from useSynth ----

  function snapshotProjectForSync(): ProjectSyncSnapshot {
    return {
      bpm: project.bpm,
      tracks: project.tracks.map((t) => ({
        engineType: t.engineType,
        patternLength: t.patternLength,
        enabled: t.enabled,
        mixer: { ...t.mixer } as unknown as Record<string, unknown>,
        steps: t.steps.map((s) => ({ ...s }) as unknown as Record<string, unknown>),
        engines: Object.fromEntries(
          ENGINE_SLICES.map((slice) => [
            slice,
            cloneEngineSlice(t.engines[slice] as unknown as Record<string, unknown>),
          ]),
        ),
      })),
    };
  }

  // Enqueue-only leaf diff (state is already replaced wholesale by loadProject;
  // re-dispatching would be thousands of redundant writes — see the spec).
  function enqueueLeafDiff(
    prefix: Path,
    changed: Record<string, unknown>,
    oldObj: Record<string, unknown> | undefined,
  ): void {
    for (const [key, value] of Object.entries(changed)) {
      if (Array.isArray(value)) continue;
      if (value !== null && typeof value === 'object') {
        const oldNested = (oldObj?.[key] ?? {}) as Record<string, unknown>;
        const newNested = value as Record<string, unknown>;
        for (const subKey of Object.keys(newNested)) {
          if (oldNested[subKey] === newNested[subKey]) continue;
          deps.enqueue([...prefix, key, subKey], newNested[subKey], oldNested[subKey], gestureEndForLeaf(subKey));
        }
      } else {
        deps.enqueue([...prefix, key], value, oldObj?.[key], gestureEndForLeaf(key));
      }
    }
  }

  function enqueueMatrixDiff(
    trackIdx: number,
    newSlice: Record<string, unknown>,
    oldSlice: Record<string, unknown>,
  ): void {
    const newM = (newSlice as { matrix?: Record<string, unknown>[] }).matrix;
    const oldM = (oldSlice as { matrix?: Record<string, unknown>[] }).matrix;
    if (!newM || !oldM) return;
    for (let s = 0; s < newM.length; s++) {
      for (const field of ['source', 'dest', 'amount'] as const) {
        const a = newM[s]?.[field]; const o = oldM[s]?.[field];
        if (a === o) continue;
        deps.enqueue(['tracks', trackIdx, 'engines', 'synth2', 'matrix', s, field], a, o, gestureEndForLeaf(field));
      }
    }
  }

  function enqueueWholeProjectDiff(before: ProjectSyncSnapshot): void {
    if (project.bpm !== before.bpm) deps.enqueue(['bpm'], project.bpm, before.bpm, gestureEndForLeaf('bpm'));
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      const t = project.tracks[i]; const b = before.tracks[i];
      const headNew = { engineType: t.engineType, patternLength: t.patternLength, enabled: t.enabled } as Record<string, unknown>;
      const headOld = { engineType: b.engineType, patternLength: b.patternLength, enabled: b.enabled } as Record<string, unknown>;
      const headChanged = diffParams(headNew, headOld);
      if (headChanged) enqueueLeafDiff(['tracks', i], headChanged, headOld);
      const mixChanged = diffParams(t.mixer as unknown as Record<string, unknown>, b.mixer);
      if (mixChanged) enqueueLeafDiff(['tracks', i, 'mixer'], mixChanged, b.mixer);
      for (let j = 0; j < t.steps.length; j++) {
        const sc = diffParams(t.steps[j] as unknown as Record<string, unknown>, b.steps[j]);
        if (sc) enqueueLeafDiff(['tracks', i, 'steps', j], sc, b.steps[j]);
      }
      for (const slice of ENGINE_SLICES) {
        const ec = diffParams(t.engines[slice] as unknown as Record<string, unknown>, b.engines[slice]);
        if (ec) enqueueLeafDiff(['tracks', i, 'engines', slice], ec, b.engines[slice]);
      }
      enqueueMatrixDiff(i, t.engines.synth2 as unknown as Record<string, unknown>, b.engines.synth2);
    }
  }

  function loadAndSyncWholeProject(next: Project): void {
    const before = deps.isSyncLive() ? snapshotProjectForSync() : null;
    bus.loadProject(next);
    if (before) enqueueWholeProjectDiff(before);
  }

  // ---- the public ops ----

  return {
    clearTrack(trackId: number): void {
      dispatchStepsWindow(trackId, clearTrackDraft(project.tracks[trackId].patternLength) as unknown as Record<string, unknown>[]);
    },
    shiftTrack(trackId: number, direction: 'left' | 'right'): void {
      const t = project.tracks[trackId];
      dispatchStepsWindow(trackId, shiftTrackDraft(t.steps, direction, t.patternLength) as unknown as Record<string, unknown>[]);
    },
    fillTrack(trackId: number, interval: number): void {
      const t = project.tracks[trackId];
      dispatchStepsWindow(trackId, fillTrackDraft(t.steps, interval, t.patternLength) as unknown as Record<string, unknown>[]);
    },
    applyPreset(trackId: number, preset: Preset): void {
      const t = project.tracks[trackId];
      // engineType FIRST so the swap syncs with the correct prior (the OLD engine);
      // the draft depends only on the slice, so ordering is safe.
      dispatch(['tracks', trackId, 'engineType'], preset.engineType, t.engineType);
      const live = t.engines[preset.engineType] as unknown as Record<string, unknown>;
      const draft = applyPresetDraft(t, preset);
      dispatchDiff(['tracks', trackId, 'engines', preset.engineType], draft, live);
      if (preset.engineType === 'synth2') dispatchMatrixDiff(trackId, draft, live);
    },
    initPatch(trackId: number): void {
      const t = project.tracks[trackId];
      const live = t.engines[t.engineType] as unknown as Record<string, unknown>;
      const draft = resetEnginePatchDraft(t);
      dispatchDiff(['tracks', trackId, 'engines', t.engineType], draft, live);
      if (t.engineType === 'synth2') dispatchMatrixDiff(trackId, draft, live);
    },
    newProject(): void { loadAndSyncWholeProject(freshProject()); },
    openProject(loaded: Project): void { loadAndSyncWholeProject(loaded); },
  };
}

export type ProjectOps = ReturnType<typeof createProjectOps>;
```

- [ ] **Step 8: Run the new tests**

Run: `npm run -w @fiddle/client test -- --run src/app/projectOps.test.ts`
Expected: PASS (all).

- [ ] **Step 9: Wire useSynth + StudioView through projectOps**

In `useSynth.ts`:
1. DELETE: `emitLeafDiff`, `emitMatrixDiff`, `syncEngineParamsDiff`, `syncStepWindowDiff`, `syncWholeProjectDiff`, `snapshotProjectForSync`, `cloneEngineSlice`, `ProjectSyncSnapshot`, and the `ENGINE_SLICES` const (its only consumers just left). Delete the now-unused `diffParams` and `TRACK_POOL_SIZE`-if-unused imports (check: `TRACK_POOL_SIZE` is still used by `removeTrack` — keep it).
2. Add below the `audioEngine` construction:

```ts
// Bulk project operations (Clear/Shift/Fill, preset load, INIT PATCH, New/Open)
// as pure draft-diff-dispatch through the bus. Interim module-scope instance —
// Phase 5 Task 4 moves this onto the synth context.
export const projectOps = createProjectOps({
  project,
  bus,
  isSyncLive: () => session.isSyncLive,
  enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
});
```

with `import { createProjectOps } from '../app/projectOps';`.

In `StudioView.vue`:
1. Import line 308 becomes `import { dispatchLocal, projectOps } from '../composables/useSynth';`.
2. From the `'../project'` import block delete: `clearTrack as clearProjectTrack`, `shiftTrack as shiftProjectTrack`, `fillTrack as fillProjectTrack`, `replaceProject`, `freshProject`, `applyPreset`, `resetEnginePatch` (keep the file-io, `makePreset`, `PRESET_SCHEMA_VERSION`, and type imports).
3. Replace the handlers:

```ts
function applyPresetSynced(trackIdx: number, preset: Preset): void {
  projectOps.applyPreset(trackIdx, preset);
}

const onClear = (trackId: number) => { projectOps.clearTrack(trackId); };
const onShift = ({ trackId, direction }: { trackId: number; direction: 'left' | 'right' }) => {
  projectOps.shiftTrack(trackId, direction);
};
const onFill = ({ trackId, interval }: { trackId: number; interval: number }) => {
  projectOps.fillTrack(trackId, interval);
};
```

`onNew`: keep the confirm dialog; the post-confirm body becomes `projectOps.newProject();`. `onOpen`: keep the file-dialog + error handling; the success body becomes `projectOps.openProject(loaded);`. `onInitPatch`: keep the dialog + re-check; the post-confirm body becomes:

```ts
  if (ok && activeTrackIndex.value !== null) {
    projectOps.initPatch(activeTrackIndex.value);
  }
```

- [ ] **Step 10: Delete the superseded emitter tests**

In `useSynth.test.ts`, delete the tests that exercised the now-removed exports (their coverage moved to `projectOps.test.ts`): `'syncStepWindowDiff emits changed step fields as leaf ops (C1)'`, `'syncStepWindowDiff emits nothing when the window is unchanged (C1 regression)'`, `'syncWholeProjectDiff emits bpm, patternLength, mixer.volume, and step note (M3)'`, `'syncWholeProjectDiff emits nothing when snapshot matches live (M3 regression)'`, `'applyPreset emits the changed engine-slice params'`, `'whole-project diff emits engine-slice param changes (Open/New)'`, `'whole-project diff emits matrix leaf changes (Open/New)'`, `'syncEngineParamsDiff emits synth2 matrix changes (preset load / INIT PATCH)'`. Any other test referencing the deleted exports gets the same treatment — grep the file for the deleted names; zero references must remain.

- [ ] **Step 11: Full gate**

Run the full gate. Also `grep -rn "applyPreset(\|resetEnginePatch(\|clearTrack(\|shiftTrack(\|fillTrack(" packages/client/src --include='*.ts' --include='*.vue' | grep -v Draft | grep -v test` — expected: no survivors outside `projectOps.ts` internals. Fix any test files still importing the old mutating helpers by porting them to the draft API.

- [ ] **Step 12: Commit**

```bash
git add packages/client/src/sync/dispatchPolicy.ts packages/client/src/app/projectOps.ts packages/client/src/app/projectOps.test.ts packages/client/src/project/mutations.ts packages/client/src/project/preset.ts packages/client/src/project/paramDiff.ts packages/client/src/project/index.ts packages/client/src/composables/useSynth.ts packages/client/src/views/StudioView.vue packages/client/src/composables/useSynth.test.ts
git commit -m "feat(app): bulk project ops as pure draft-diff-dispatch through the bus (phase 5 task 2)"
```

(Include any additional ported test files in the `git add`.)

---

### Task 3: AudioEngine — watchers → command-stream subscription

**Files:**
- Modify: `packages/client/src/audio/AudioEngine.ts`, `packages/client/src/audio/AudioEngine.test.ts`, `packages/client/src/composables/useSynth.ts`, `packages/client/src/engine/TrackMixer.test.ts`, `packages/client/src/composables/useSynth.test.ts`

**Interfaces:**
- Consumes: `AppliedCommand` from `../project/appliedCommand` (Task 1); `bus.subscribe` (Task 1).
- Produces: `AudioEngineDeps` becomes `{ project: Project; subscribe: (l: (cmd: AppliedCommand) => void) => () => void }`. `AudioState.scope: EffectScope` is REPLACED by `unsubscribe: () => void`.

- [ ] **Step 1: Rewrite AudioEngine.test.ts for the stream**

Replace the `makeEngine` helper and the param test; add the new contract tests (keep the Web Audio mock block and the first/second/fourth tests structurally — the dispose test drops its scope-related implicit behavior but its assertions stay valid):

```ts
import { setDeep, type Path } from '@fiddle/shared';
import type { AppliedCommand } from '../project/appliedCommand';

function makeEngine() {
  const project = reactive(freshProject()) as Project;
  const listeners = new Set<(cmd: AppliedCommand) => void>();
  const engine = new AudioEngine({
    project,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  });
  const emit = (cmd: AppliedCommand) => { for (const l of listeners) l(cmd); };
  // Simulate a bus write: state first, then the synchronous stream event.
  const set = (path: Path, value: unknown) => {
    setDeep(project as unknown as Record<string, unknown>, path, value);
    emit({ kind: 'set', path, value });
  };
  return { project, engine, set, emit, listeners };
}
```

Replace `'forwards only the changed key when one active-engine param is mutated'` with (note: no `nextTick` — the reaction is synchronous now):

```ts
  it('applies a dispatched param to the active engine (single key, from live state)', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();

    set(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234);

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith({ filterCutoff: 1234 });
  });

  it('a DIRECT reactive mutation no longer reaches audio (watchers are gone)', async () => {
    const { project, engine } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();
    project.tracks[0].engines.synth.filterCutoff = 777;   // bypasses the bus
    await nextTick();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('applies a nested sub-object as a whole re-read superset', async () => {
    const { project, engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();
    set(['tracks', 0, 'engines', 'synth', 'filterEnv', 'a'], 0.42);
    expect(applySpy).toHaveBeenCalledTimes(1);
    // whole filterEnv (live re-read), not just {a}:
    expect(applySpy.mock.calls[0][0]).toEqual({ filterEnv: expect.objectContaining({ a: 0.42 }) });
  });

  it('ignores a param set for an inactive engine slice', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();
    set(['tracks', 0, 'engines', 'kick', 'level'], 0.5);   // track 0 is synth
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('enabled=false disposes the slot engine; enabled=true rebuilds it', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    expect(state.engines[0]).toBeDefined();
    set(['tracks', 0, 'enabled'], false);
    expect(state.engines[0]).toBeUndefined();
    set(['tracks', 0, 'enabled'], true);
    expect(state.engines[0]).toBeDefined();
  });

  it('engineType set swaps the slot engine', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const before = state.engines[0]!;
    set(['tracks', 0, 'engineType'], 'kick');
    expect(state.engines[0]).not.toBe(before);
    expect(state.engines[0]!.engineType).toBe('kick');
  });

  it('a replace event re-syncs every slot from current state', async () => {
    const { project, engine, emit } = makeEngine();
    const state = await engine.ensureAudio();
    // wholesale replace outside the leaf-op path (snapshot / Open / New):
    project.tracks[0].engineType = 'kick';
    project.tracks[1].enabled = false;
    emit({ kind: 'replace' });
    expect(state.engines[0]!.engineType).toBe('kick');
    expect(state.engines[1]).toBeUndefined();
  });

  it('dispose unsubscribes from the stream', async () => {
    const { engine, listeners } = makeEngine();
    await engine.ensureAudio();
    expect(listeners.size).toBe(1);
    engine.dispose();
    expect(listeners.size).toBe(0);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w @fiddle/client test -- --run src/audio/AudioEngine.test.ts`
Expected: FAIL — `subscribe` missing from deps type; new tests fail against the watcher implementation.

- [ ] **Step 3: Implement the swap in AudioEngine.ts**

1. Imports: delete `watch`, `effectScope`, `type EffectScope` from the vue import; delete the `diffParams` import; add `import type { AppliedCommand } from '../project/appliedCommand';`.
2. `AudioState`: replace `scope: EffectScope;` with `unsubscribe: () => void;` (update the field comment: "stream subscription torn down in dispose()").
3. `AudioEngineDeps`:

```ts
export interface AudioEngineDeps {
  project: Project;
  /** Subscribe to the bus's applied-command stream; returns an unsubscribe. */
  subscribe: (listener: (cmd: AppliedCommand) => void) => () => void;
}
```

4. In `buildAudioState`, DELETE the entire `const scope = effectScope(true); scope.run(() => { ... });` block (lines ~244-292: the engineType / per-slice / mixer / enabled watchers and their comments) and replace with:

```ts
    // Audio reactions ride the bus's applied-command stream (Phase 5) instead
    // of Vue watchers: the bus emits synchronously after every state write —
    // local dispatch, remote op, nack rollback — the same timing flush:'sync'
    // gave the old watchers. `replace` (snapshot / Open / New / room reset)
    // re-runs the same full sync the initial build above just did. The handler
    // only touches audio nodes — never dispatches (bus stream constraint).
    const onCommand = (cmd: AppliedCommand): void => {
      if (cmd.kind === 'replace') {
        for (let i = 0; i < TRACK_POOL_SIZE; i++) syncTrackToEngine(i);
        updateMixerGains();
        return;
      }
      const p = cmd.path;
      if (p[0] !== 'tracks' || typeof p[1] !== 'number') return; // bpm etc.: sequencer pulls per tick
      const i = p[1];
      switch (p[2]) {
        case 'engineType':
          syncTrackToEngine(i);
          return;
        case 'enabled':
          syncTrackToEngine(i);
          updateMixerGains();
          return;
        case 'mixer':
          updateMixerGains();
          return;
        case 'engines': {
          const slice = p[3] as EngineType;
          if (project.tracks[i].engineType !== slice) return; // inactive slice
          const engine = engines[i];
          if (!engine) return; // disabled slot — params apply on enable via syncTrackToEngine
          const key = p[4];
          if (typeof key !== 'string') return;
          // Re-read the top-level key from live state: a nested-leaf edit
          // applies its whole sub-object (superset — applyParams setters are
          // idempotent per param); a matrix slot edit applies the whole matrix.
          const liveSlice = project.tracks[i].engines[slice] as unknown as Record<string, unknown>;
          engine.applyParams({ [key]: snapshot(liveSlice[key]) } as Record<string, any>);
          return;
        }
        default:
          return; // steps / patternLength — pull model, no audio reaction
      }
    };
    const unsubscribe = this.deps.subscribe(onCommand);

    return { ctx, trackAnalysers, trackGains, engines, pendingDisposes, unsubscribe };
```

5. In `dispose()`: replace `state.scope.stop();` with `state.unsubscribe();`.
6. Update the class doc comment: "the audio-reaction watchers" → "the audio-reaction stream subscription".

- [ ] **Step 4: Wire the subscription in useSynth**

`const audioEngine = new AudioEngine({ project, subscribe: bus.subscribe });` (the `bus` const from Task 1 is declared above it — verify the order: bus → session? No: bus is declared before `session`? The Task 1 code places bus above session and `audioEngine` already sits below both — just update the constructor call.)

- [ ] **Step 5: Port the direct-mutation tests**

These test files drive audio via direct reactive mutation, which no longer reaches audio — convert each mutation to a dispatch (the tests then exercise the real write path):

- `packages/client/src/engine/TrackMixer.test.ts`: every `synthData.project.tracks[N].mixer.X = v` becomes `mod.dispatchLocal(['tracks', N, 'mixer', 'X'], v)` (the file already imports the module as `mod`; if it only holds `useSynth`, also grab `dispatchLocal` from the same dynamic import). Same for the beforeEach loop seeding `track.mixer.volume/muted/soloed` — seed via `mod.dispatchLocal` after boot, or seed BEFORE `ensureAudio()` (build-time apply covers pre-boot state; keep whichever the existing assertions need).
- `packages/client/src/composables/useSynth.test.ts` — the `'useSynth narrow watchers (A2)'` describe (rename it `'audio reactions via the command stream (A2)'`): `project.tracks[0].engines.synth.filterCutoff = 1234` → `mod.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234)`; the envelope-leaf test now expects the SUPERSET call (`{ filterEnv: expect.objectContaining({ a: <v> }) }` instead of the exact diffed `{ filterEnv: { a: <v> } }`); the inactive-slice test dispatches to the inactive slice path. The `'lazy per-slot engines (E1)'` describe: `enabled` toggles via `mod.dispatchLocal(['tracks', N, 'enabled'], v)`; pre-enable param edits via dispatch. Remove any `await nextTick()` that only existed for watcher flushing (reactions are synchronous now); keep the ones covering Vue computed updates.

- [ ] **Step 6: Full gate**

Run the full gate. Every remaining `useSynth.test.ts` sync test must still pass — remote ops (`applyRemote`) now reach audio through the stream exactly as the watchers did.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/audio/AudioEngine.ts packages/client/src/audio/AudioEngine.test.ts packages/client/src/composables/useSynth.ts packages/client/src/engine/TrackMixer.test.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(audio): AudioEngine subscribes to the applied-command stream; watchers deleted (phase 5 task 3)"
```

**Controller checkpoint after Task 3:** two-tab browser verification on the local Docker DB (`npm run dev:obs`): knob → audible + peer-visible; peer edit → audible locally; preset load + INIT PATCH audible; engine swap while playing; Clear/Shift/Fill converge; Open/New converge; console clean.

---

### Task 4: The atomic swap — AppRuntime, synthContext, delete useSynth.ts

**Files:**
- Create: `packages/client/src/app/AppRuntime.ts`, `packages/client/src/app/synthContext.ts`, `packages/client/src/app/AppRuntime.test.ts`, `packages/client/src/app/synthContext.test.ts`
- Modify: `packages/client/src/stores/project.ts`, `packages/client/src/stores/project.test.ts`, `packages/client/src/main.ts`, `packages/client/src/App.vue`, `packages/client/src/components/ErrorOverlay.vue`, `packages/client/src/sync/knobSync.ts` (+ its test), `packages/client/src/sync/commandModel.ts` (+ its test), `packages/client/src/views/StudioView.vue`, `packages/client/src/components/Sidebar.vue`, `packages/client/src/views/LobbyView.vue`
- Delete: `packages/client/src/composables/useSynth.ts`, `packages/client/src/composables/useSynth.test.ts` (ported), `packages/client/src/sync/synthContext.ts`

**Interfaces:**
- Consumes: everything Tasks 1–3 produced.
- Produces:
  - `createAppRuntime(opts?: { wsClientFactory?: WsClientFactory; syncEnabled?: boolean }): AppRuntime` and `RUNTIME_KEY: InjectionKey<AppRuntime>` from `app/AppRuntime`
  - `createSynthContext(runtime: AppRuntime)`, `SYNTH_CONTEXT: InjectionKey<SynthContext>`, `type SynthContext` from `app/synthContext` — context shape is the useSynth() return PLUS `dispatchLocal`, `endGesture`, `projectOps`
  - `useProjectStore` creates `project` internally (per Pinia instance)

- [ ] **Step 1: Per-page project store**

Replace `packages/client/src/stores/project.ts`:

```ts
import { defineStore } from 'pinia';
import { reactive, computed } from 'vue';
import { freshProject, replaceProject, type Project, type ProjectTrack, type EngineType } from '../project';
import { setDeep, type Path } from '@fiddle/shared';

export const useProjectStore = defineStore('project', () => {
  // THE canonical project instance — created per Pinia instance, i.e. per
  // AppRuntime (one per page; one per test runtime). Phase 5: creation moved
  // in here from module scope, so re-evaluating any module mints nothing.
  // Holds ONLY data — no socket, no AudioContext, no timers.
  const project = reactive<Project>(freshProject());

  const enabledTrackCount = computed(() => project.tracks.filter((t) => t.enabled).length);

  function getTrack(index: number): ProjectTrack {
    return project.tracks[index];
  }

  const bpm = computed(() => project.bpm);

  function getTrackEngineType(index: number): EngineType {
    return project.tracks[index].engineType;
  }

  // The single low-level state-write primitive — reached ONLY via the
  // CommandBus. Pure state: no suppression, no opId logic, no sync.
  function applySet(path: Path, value: unknown): void {
    setDeep(project as unknown as Record<string, unknown>, path, value);
  }

  // Replace the project's contents in place (snapshot load / Open / New / room
  // reset), preserving object identity so reactive bindings survive. Reached
  // ONLY via CommandBus.loadProject.
  function loadProject(next: Project): void {
    replaceProject(project, next);
  }

  return { project, enabledTrackCount, getTrack, getTrackEngineType, bpm, applySet, loadProject };
});
```

(The raw `export { project }` and `__resetProjectStoreForTest` are gone.) Update `stores/project.test.ts`: replace `__resetProjectStoreForTest()` calls with `setActivePinia(createPinia())` in a `beforeEach` (imports from `'pinia'`) — a fresh Pinia now genuinely isolates, which is the point.

- [ ] **Step 2: AppRuntime**

`packages/client/src/app/AppRuntime.ts`:

```ts
// AppRuntime — the composition root. The ONLY place the app's long-lived
// resources (project store, command bus, sync session, audio engine) are
// created, and the ONLY owner of their teardown. main.ts creates one per page
// and wires every lifecycle event (pagehide, HMR) to shutdown(). Tests create
// one per test — fresh, isolated, no module-reset gymnastics.
import { createPinia, type Pinia } from 'pinia';
import type { InjectionKey } from 'vue';
import { useProjectStore } from '../stores/project';
import { createCommandBus, type CommandBus } from '../sync/CommandBus';
import { SyncSession, type WsClientFactory } from '../sync/SyncSession';
import { WsClient } from '../sync/WsClient';
import { AudioEngine } from '../audio/AudioEngine';
import { useAuth } from '../auth/useAuth';

export interface AppRuntimeOptions {
  /** Test seam: hand back a fake WsClient instead of opening real sockets. */
  wsClientFactory?: WsClientFactory;
  /** Test seam: false keeps the WS layer dark (connect only reflects the room id). */
  syncEnabled?: boolean;
}

export interface AppRuntime {
  pinia: Pinia;
  store: ReturnType<typeof useProjectStore>;
  bus: CommandBus;
  session: SyncSession;
  audio: AudioEngine;
  /** Idempotent full teardown: audio (ctx/engines/transport) then sync (socket). */
  shutdown(): void;
}

export const RUNTIME_KEY: InjectionKey<AppRuntime> = Symbol('appRuntime');

export function createAppRuntime(opts: AppRuntimeOptions = {}): AppRuntime {
  const pinia = createPinia();
  const store = useProjectStore(pinia);
  const project = store.project;

  // bus ↔ session wiring: the bus needs the session's gated outbound enqueue;
  // the session needs the bus for inbound ops. The arrow late-binds `session`
  // (it only runs on a dispatch, long after both exist).
  let session: SyncSession;
  const bus = createCommandBus({
    applySet: store.applySet,
    loadProject: store.loadProject,
    enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
  });
  session = new SyncSession({
    bus,
    wsClientFactory: () => (opts.wsClientFactory ?? ((o) => new WsClient(o))),
    syncEnabled: () => opts.syncEnabled ?? true,
    auth: () => useAuth(),
  });
  const audio = new AudioEngine({ project, subscribe: bus.subscribe });

  function shutdown(): void {
    audio.dispose();
    session.dispose();
  }

  return { pinia, store, bus, session, audio, shutdown };
}
```

Note: `store.project` through a setup store is the raw reactive object (Pinia passes `reactive()` values through) — verify with the AppRuntime test's identity assertion below.

- [ ] **Step 3: synthContext — the preserved facade**

`packages/client/src/app/synthContext.ts` — this ABSORBS the `useSynth()` body plus the module-scope helpers, delegating to the runtime. Port VERBATIM from `useSynth.ts` at HEAD (same comments) with these substitutions: `session.` → destructured `session` from the runtime, `audioEngine.` → `audio.`, `bus.` stays (destructured), `project` → `runtime.store.project`, `resetLocalProject()` body → `bus.loadProject(freshProject())`. Exact imports (assembled from useSynth.ts's surviving needs):

```ts
import { ref, computed, type InjectionKey } from 'vue';
import type { OscillatorTypeLiteral, Path } from '@fiddle/shared';
import { getDeep, TRACK_POOL_SIZE } from '@fiddle/shared';
import { type EngineType, freshProject } from '../project';
import { setRoomInUrl, clearRoomFromUrl, setFocusedTrackInUrl } from '../sync/roomId';
import { roster, selfClientId } from '../sync/presence';
import { gestureEndForLeaf } from '../sync/dispatchPolicy';
import { createProjectOps } from './projectOps';
import type { AppRuntime } from './AppRuntime';

export type SynthContext = ReturnType<typeof createSynthContext>;
export const SYNTH_CONTEXT: InjectionKey<SynthContext> = Symbol('synthContext');

// createSynthContext — builds the injected facade the component tree consumes.
// Called EXACTLY ONCE, by App.vue (the never-unmounting shell), with the
// page's AppRuntime. Everything stateful in here (activeTrackIndex,
// sessionName) is per-context — i.e. per page — replacing useSynth's per-call
// refs and module-scope singletons.
export function createSynthContext(runtime: AppRuntime) {
  const { bus, session, audio } = runtime;
  const project = runtime.store.project;

  const activeTrackIndex = ref<number | null>(null);
  const sessionName = ref<string | null>(null);

  function dispatchLocal(path: Path, value: unknown): void {
    const gestureEnd = gestureEndForLeaf(String(path[path.length - 1]));
    const priorValue = getDeep(project as unknown as Record<string, unknown>, path);
    bus.dispatchLocal({ path, value, priorValue, gestureEnd });
  }

  function endGesture(path: Path): void {
    session.flushPath(path);
  }

  const projectOps = createProjectOps({
    project,
    bus,
    isSyncLive: () => session.isSyncLive,
    enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
  });

  // connectToSession / resetLocalProject / leaveSession: verbatim from
  // useSynth.ts (same comments), with resetLocalProject = bus.loadProject(freshProject())
  // and the view reset folded in (was in the useSynth() return wrappers).
  function connectToSession(roomId: string, opts?: { history?: 'push' | 'replace'; force?: boolean }): void {
    const alreadyHere = !opts?.force && session.isConnected && session.currentRoomId.value === roomId;
    setRoomInUrl(roomId, alreadyHere ? 'replace' : (opts?.history ?? 'replace'));
    activeTrackIndex.value = null;   // entering a session always opens the overview (was in the useSynth() wrapper)
    if (!session.isSyncEnabled) { session.connect(roomId); return; }   // test mode: reflect the room, no socket
    if (alreadyHere) return;
    // teardown → reset → build ordering, verbatim from useSynth.connectToSession:
    if (session.isConnected) session.disconnect();
    bus.loadProject(freshProject());
    session.connect(roomId);
  }
  // ... leaveSession / bpm / focusedTrack / shortestActiveNoteDuration /
  // applyFocusedTrack / selectTrack / setFocusedTrack / getTrackEngineType /
  // enabledTrackCount / addTrack / removeTrack / waveforms: verbatim port —
  // see the instruction paragraph below.
}
```

**The trailing `// ...` comment marks the verbatim-port section** — the implementer copies the full bodies of `leaveSession` (with the view reset folded in: `activeTrackIndex.value = null`, no double wrapper), the `bpm` computed, `focusedTrack`, `shortestActiveNoteDuration`, `applyFocusedTrack`/`selectTrack`/`setFocusedTrack`, `getTrackEngineType`, `enabledTrackCount`, `addTrack`, `removeTrack`, and `waveforms` from `useSynth.ts` at HEAD (the source of truth — do not retype from memory), then builds the return object: the same member list as `useSynth()`'s return, PLUS `dispatchLocal`, `endGesture`, `projectOps`. Two supporting changes: (1) add a one-line getter to `SyncSession`: `get isSyncEnabled(): boolean { return this.deps.syncEnabled(); }` (used by `connectToSession`'s test-mode branch above, which previously read useSynth's module-scope flag); (2) `leaveSession`'s `resetLocalProject()` call becomes `bus.loadProject(freshProject())`, same as in `connectToSession`.

- [ ] **Step 4: main.ts — the single lifecycle file**

```ts
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { createAppRuntime, RUNTIME_KEY } from './app/AppRuntime'

// The composition root: every long-lived resource is created here (inside
// createAppRuntime) and torn down through the one shutdown() below. No other
// module creates resources at module scope, and no other module references
// page lifecycle or import.meta.hot.
const runtime = createAppRuntime()

createApp(App)
  .use(runtime.pinia)
  .use(router)
  .provide(RUNTIME_KEY, runtime)
  .mount('#app')

// Page teardown. `pagehide` covers navigation, tab close, AND bfcache-freeze
// (the frozen socket dies anyway; App.vue's pageshow.persisted handler force-
// reconnects on restore, and audio re-boots lazily on the next PLAY).
window.addEventListener('pagehide', () => runtime.shutdown())

// HMR (dev): a hot swap of this entry disposes the old core before the new one
// boots — dispose-and-recreate. Non-accepted module edits full-reload instead,
// which fires pagehide → the same shutdown. The ONLY import.meta.hot in the app.
if (import.meta.hot) {
  import.meta.hot.dispose(() => runtime.shutdown())
}
```

- [ ] **Step 5: App.vue + the four importers**

- `App.vue`: replace `import { useSynth } from './composables/useSynth';` + `import { SYNTH_CONTEXT } from './sync/synthContext';` with `import { RUNTIME_KEY } from './app/AppRuntime';` + `import { createSynthContext, SYNTH_CONTEXT } from './app/synthContext';`; replace `const synth = useSynth();` with:

```ts
const runtime = inject(RUNTIME_KEY);
if (!runtime) throw new Error('RUNTIME_KEY not provided — main.ts must provide the AppRuntime');
const synth = createSynthContext(runtime);
```

(add `inject` to the vue import; the `provide(SYNTH_CONTEXT, synth)` / `provide(ACTIVE_TRACK_KEY, ...)` lines stay; update the stale comment above them).
- `components/ErrorOverlay.vue`: replace the useSynth import+call with `import { inject } from 'vue'; import { SYNTH_CONTEXT } from '../app/synthContext';` and `const synth = inject(SYNTH_CONTEXT); if (!synth) throw new Error('SYNTH_CONTEXT not provided'); const { fatalError } = synth;`.
- `sync/knobSync.ts`: drop the useSynth import; inject the context with a dormant fallback (matches the file's existing degrade-don't-throw stance):

```ts
import { SYNTH_CONTEXT } from '../app/synthContext';
...
export function useKnobSync(engine: EngineType) {
  const activeTrack = inject(ACTIVE_TRACK_KEY, ref<number | null>(null));
  // Dormant outside the provider (tests): set/end become no-ops.
  const synth = inject(SYNTH_CONTEXT, null);
  ...
  function end(field: string | ReadonlyArray<string | number>): void {
    const p = pathFor(field);
    if (p.length === 0 || !synth) return;
    synth.endGesture(p);
  }
  function set(field: Field, value: unknown): void {
    const p = pathFor(field);
    if (p.length === 0 || !synth) return;
    synth.dispatchLocal(p, value);
  }
  ...
}
```

- `sync/commandModel.ts`: drop the `project` + `dispatchLocal` imports; inject:

```ts
import { computed, inject, type WritableComputedRef } from 'vue';
import { getDeep, type Path } from '@fiddle/shared';
import { SYNTH_CONTEXT } from '../app/synthContext';

export function useCommandModel<T = unknown>(
  path: Path | (() => Path),
): WritableComputedRef<T> {
  const synth = inject(SYNTH_CONTEXT);
  if (!synth) throw new Error('useCommandModel requires SYNTH_CONTEXT (provided by App)');
  const resolve = typeof path === 'function' ? path : () => path;
  return computed<T>({
    get: () => getDeep(synth.project as unknown as Record<string, unknown>, resolve()) as T,
    set: (v) => synth.dispatchLocal(resolve(), v),
  });
}
```

- `views/StudioView.vue`: delete the `import { dispatchLocal, projectOps } from '../composables/useSynth';` line; take both off the injected context instead — after the existing `const synth = inject(SYNTH_CONTEXT)` guard add `const { dispatchLocal, projectOps } = synth;` (the file's other `synth.` usages are already context-based). Update the `SYNTH_CONTEXT` import path to `'../app/synthContext'`.
- `components/Sidebar.vue` + `views/LobbyView.vue`: import-path update only (`'../sync/synthContext'` → `'../app/synthContext'`).
- Delete `sync/synthContext.ts`.
- Their tests (`knobSync.test.ts`, `commandModel.test.ts`): these composables now inject — run them inside a host component context the way the existing tests already do (both files already test inject-consuming composables via `ACTIVE_TRACK_KEY`), providing a minimal fake context: `{ project: reactive(freshProject()), dispatchLocal: vi.fn(), endGesture: vi.fn() }` under `SYNTH_CONTEXT`. Follow each file's existing harness pattern; assert `dispatchLocal` receives the path+value the old tests asserted against the module spy.

- [ ] **Step 6: AppRuntime tests (the marquee)**

`packages/client/src/app/AppRuntime.test.ts` (reuse the standard Web Audio mock block from `AudioEngine.test.ts`, and the `makeFakeWsClient` + `stubEnv` shapes from `SyncSession.test.ts`):

```ts
describe('AppRuntime', () => {
  it('bootstrap builds a working core; shutdown stops the transport, closes the ctx and socket; second shutdown is a no-op', async () => {
    stubEnv();
    const built: any[] = [];
    const runtime = createAppRuntime({
      wsClientFactory: (o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; },
    });
    // state writes flow: bus → store
    runtime.bus.dispatchLocal({ path: ['bpm'], value: 141 });
    expect(runtime.store.project.bpm).toBe(141);

    await runtime.audio.ensureAudio();
    await runtime.audio.togglePlay();
    expect(runtime.audio.sequencer.isPlaying).toBe(true);
    runtime.session.connect('room-x');
    expect(built).toHaveLength(1);

    runtime.shutdown();
    expect(runtime.audio.sequencer.isPlaying).toBe(false);       // transport stopped
    expect(runtime.audio.trackGains.value).toBeNull();           // ctx torn down
    expect(built[0].disconnect).toHaveBeenCalled();              // socket closed
    expect(runtime.session.isConnected).toBe(false);

    runtime.shutdown();                                          // idempotent
    expect(built[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('two runtimes are fully isolated (per-page project)', () => {
    const a = createAppRuntime({ syncEnabled: false });
    const b = createAppRuntime({ syncEnabled: false });
    a.bus.dispatchLocal({ path: ['bpm'], value: 150 });
    expect(a.store.project.bpm).toBe(150);
    expect(b.store.project.bpm).not.toBe(150);
    expect(a.store.project).not.toBe(b.store.project);
  });

  it('the runtime survives shutdown: audio re-boots and a room re-connects (bfcache restore path)', async () => {
    stubEnv();
    const built: any[] = [];
    const runtime = createAppRuntime({
      wsClientFactory: (o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; },
    });
    await runtime.audio.ensureAudio();
    runtime.session.connect('room-x');
    runtime.shutdown();
    await runtime.audio.ensureAudio();                            // rebuilds from null
    expect(runtime.audio.trackGains.value).not.toBeNull();
    runtime.session.connect('room-x');
    expect(built).toHaveLength(2);                                // fresh socket
    runtime.shutdown();
  });
});
```

- [ ] **Step 7: Port useSynth.test.ts → synthContext.test.ts, then delete useSynth**

Create `packages/client/src/app/synthContext.test.ts` by porting `useSynth.test.ts` wholesale (keep the Web Audio mock block and `makeFakeWsClient` verbatim). Mechanical mapping — apply uniformly:

| Old (module pattern) | New (runtime pattern) |
|---|---|
| `vi.resetModules(); const mod = await import('./useSynth')` | `const { runtime, ctx, getFake } = makeCtx({ sync: true/false })` |
| `mod.setSyncEnabled(false)` / `(true)` | `syncEnabled: false` / `true` runtime option |
| `mod.setWsClientFactory(f)` | `wsClientFactory` runtime option |
| `mod.useSynth()` | `ctx` |
| `mod.disposeSynth()` | `runtime.shutdown()` |
| `mod.dispatchLocal(...)` / `mod.connectToSession(...)` / `mod.endGesture(...)` | `ctx.dispatchLocal(...)` / `ctx.connectToSession(...)` / `ctx.endGesture(...)` |
| `mod.projectOps.X(...)` | `ctx.projectOps.X(...)` |
| module-fresh project per test | fresh runtime per test (each `makeCtx` call) |

Shared harness at the top of the new file:

```ts
import { createAppRuntime } from './AppRuntime';
import { createSynthContext } from './synthContext';

function makeCtx(o: { sync?: boolean } = {}) {
  let fake: any;
  const runtime = createAppRuntime({
    syncEnabled: o.sync ?? false,
    wsClientFactory: (opts: any) => { fake = makeFakeWsClient(opts); return fake; },
  });
  const ctx = createSynthContext(runtime);
  return { runtime, ctx, getFake: () => fake };
}
```

Fully-worked example port (the first sync test), as the template for the rest:

```ts
  async function bootWithFakeSocket() {
    const { runtime, ctx, getFake } = makeCtx({ sync: true });
    await ctx.ensureAudio();
    ctx.connectToSession('testroom1');
    const fake = getFake()!;
    fake._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    fake._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    return { runtime, ctx, fake };
  }

  it('emits a leaf op via dispatchLocal for engine params', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'engines', 'synth', 'filterCutoff']);
    expect(fake.sent[0].value).toBe(1234);
  });
```

Port EVERY remaining test in the file this way (the audio A2/E1 describes, sync integration, session-scoped connection, variable track count, project boot S1, focused-track URL view-state — the window/location stubs port unchanged). Add `runtime.shutdown()` in `afterEach` wherever the old file called `disposeSynth()`. Then DELETE `composables/useSynth.ts` and `composables/useSynth.test.ts`. Verify: `grep -rn "composables/useSynth" packages/client/src` returns nothing, and `grep -rn "import.meta.hot" packages/client/src | grep -v main.ts` returns nothing.

- [ ] **Step 8: Full gate**

Run the full gate. Test count must be ≥ the pre-task count minus the deleted-by-design duplicates (report exact numbers). Typecheck across all 3 workspaces.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/app/AppRuntime.ts packages/client/src/app/AppRuntime.test.ts packages/client/src/app/synthContext.ts packages/client/src/app/synthContext.test.ts packages/client/src/stores/project.ts packages/client/src/stores/project.test.ts packages/client/src/main.ts packages/client/src/App.vue packages/client/src/components/ErrorOverlay.vue packages/client/src/sync/knobSync.ts packages/client/src/sync/knobSync.test.ts packages/client/src/sync/commandModel.ts packages/client/src/sync/commandModel.test.ts packages/client/src/views/StudioView.vue packages/client/src/components/Sidebar.vue packages/client/src/views/LobbyView.vue packages/client/src/sync/SyncSession.ts
git rm packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts packages/client/src/sync/synthContext.ts
git commit -m "feat(app): AppRuntime composition root + synthContext facade; delete useSynth.ts (phase 5 task 4)"
```

**Controller checkpoint after Task 4:** full two-tab browser verification on the local Docker DB, including: boot → lobby → create/join room; play; knob/step edits converge both ways; preset + INIT PATCH; Open/New; LEAVE; reload-restore; **HMR check** (edit a comment in a TS module while playing → page reloads/swaps cleanly, ONE room member after rejoin, no double audio); console clean.

---

### Task 5: Documentation — ARCHITECTURE.md D17 + supersessions, BACKLOG closure

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/BACKLOG.md`, `docs/superpowers/specs/2026-06-27-lifecycle-architecture-design.md` (mark Phase 5 row done incl. part b)

**Interfaces:** none (docs).

- [ ] **Step 1: ARCHITECTURE.md — module map + §6 rewrite**

- §2 module map: add `app/` (`AppRuntime.ts` — composition root; `synthContext.ts` — injected facade; `projectOps.ts` — bulk ops as draft-diff-dispatch); remove `composables/useSynth.ts`; note `stores/project.ts` owns per-page project creation.
- Retitle §6 from "`useSynth.ts` — explicit lazy singleton" to "`app/` — AppRuntime composition root & synthContext facade" and rewrite its Layout/Lifecycle/Return-shape subsections to describe: `createAppRuntime` (store→bus→session→audio wiring, options as test seams), the lifecycle litmus table (boot/pagehide/HMR/room enter-leave/reconnect/logout/bfcache — copy from the phase-5 spec §3), `createSynthContext` (called once by App.vue; context = useSynth's old return + `dispatchLocal`/`endGesture`/`projectOps`), and the applied-command stream data flow (bus writes → emit → audio; `replace` = full resync). Update §7's "Reactivity boundary" cross-references and any §9/§10 text that references useSynth or the watchers (grep the doc for `useSynth` — every hit gets updated or is inside a decision entry being superseded).

- [ ] **Step 2: ARCHITECTURE.md — decisions**

- **D8**: prepend `**[SUPERSEDED by D17, Phase 5 2026-07-02]** — useSynth.ts is deleted; the composition root (\`app/AppRuntime.ts\`) owns all resources and \`createSynthContext\` provides the facade.` (keep the original text below for history).
- **D10**: prepend `**[REMOVED by D17]** — with the CommandBus as sole writer there is nothing to suppress; the flag, and the flush:'sync' coupling it required, are gone.`
- **D13 / D14**: prepend `**[REVISED by D17]** — reads still bind the reactive slice, but every write now flows through dispatch (\`useKnobSync.set\` → \`ctx.dispatchLocal\` → CommandBus); knobs never mutate the slice directly.`
- **D16**: append one line: `Phase 5's AppRuntime does not change this — identity remains per-connection, owned by SyncSession.`
- Add **D17** after D16:

```markdown
### D17 — Unidirectional command architecture with an explicit composition root (Phase 5, 2026-07-02)

**What.** (a) A single long-lived `CommandBus` is the only gateway to project
state — `dispatchLocal` / `applyRemote` / `applyRollback` / `loadProject` all
converge on `ProjectStore.applySet`/`loadProject`, and the bus emits a
synchronous applied-command stream (`{kind:'set',path,value} | {kind:'replace'}`).
(b) `AudioEngine` subscribes to that stream instead of watching the reactive
project — the flush:'sync' slice-watchers and audio-side diff machinery are
gone. (c) Bulk operations (Clear/Shift/Fill, preset load, INIT PATCH) are pure
draft-diff-dispatch (`app/projectOps.ts`): helpers compute a draft, the diff is
dispatched leaf-by-leaf, the bus performs every write. (d) `AppRuntime`
(`app/AppRuntime.ts`) is the composition root: the only creator/owner of the
store, bus, `SyncSession`, and `AudioEngine`, with an idempotent `shutdown()`;
`main.ts` is the only module that touches page lifecycle (`pagehide`) or
`import.meta.hot`. (e) `project` is created per Pinia instance (per page / per
test runtime) — nothing lives at module scope.

**Why.** The app's old invariant — "useSynth.ts is evaluated exactly once per
page" — put the AudioContext, scheduler interval, and WebSocket in
module-scope with no owner and no teardown: HMR minted parallel cores
(duplicate audio, phantom room members) and reconnects leaked sockets. Making
teardown first-class and state single-writer removes the whole bug class
structurally: re-evaluating any module mints nothing, every lifecycle event
maps to one explicit call, and audio reacts to the same stream that carries
every write (local, remote, rollback, replace) — no suppression flag, no
watcher-flush coupling. Supersedes D8 and D10; revises D13/D14 (writes
dispatch; reads still bind). Design: `docs/superpowers/specs/2026-07-02-phase5-appruntime-design.md`.
```

- Update the doc's trailing *Last updated* line.

- [ ] **Step 3: BACKLOG + master spec**

- `docs/BACKLOG.md`: move the "AudioEngine command-stream params — deferred out of lifecycle Phase 4" entry out of `## Open` (to a `## Closed` section, or annotate its Status line): `**Status:** CLOSED 2026-07-02 — delivered by Phase 5 (feat/phase5-appruntime); AudioEngine subscribes to the CommandBus applied-command stream; watchers + audio-side diffParams deleted.`
- Master spec `2026-06-27-lifecycle-architecture-design.md`: on the Phase 5 row and the Phase 4 "DEFERRED" strike-note, add a completion note pointing at the phase-5 spec (mirror how the Phase-4 update block was added).

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md docs/BACKLOG.md docs/superpowers/specs/2026-06-27-lifecycle-architecture-design.md
git commit -m "docs(architecture): D17 command architecture + composition root; supersede D8/D10, revise D13/D14 (phase 5 task 5)"
```

---

## Verification (whole branch)

1. Full gate green (typecheck ×3 + client suite; server/shared suites untouched but run once at the end).
2. Greps prove the litmus items:
   - `grep -rn "import.meta.hot" packages/client/src` → `main.ts` only.
   - `grep -rn "composables/useSynth" packages/client/src` → nothing.
   - `grep -rn "setDeep(project" packages/client/src --include='*.ts' | grep -v test | grep -v stores/project` → nothing (single writer).
   - `grep -rn "new SyncSession\|new AudioEngine\|reactive(freshProject" packages/client/src --include='*.ts' | grep -v test | grep -v AppRuntime | grep -v stores/project` → nothing at module scope.
3. Controller browser checkpoints after Tasks 3 and 4 (see task footers).
4. Final whole-branch code review (superpowers:requesting-code-review), then finishing-a-development-branch.
