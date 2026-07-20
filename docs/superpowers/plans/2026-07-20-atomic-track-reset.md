# Atomic Track Reset-on-Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "add track" produce a blank, fresh track (instead of resurrecting the just-deleted one) via a single atomic whole-track sync op, while a deleted track stays restorable through Undo.

**Architecture:** Introduce one deliberate exception to the sync accept-list's leaf-only rule: an object-valued `set` at the path `['tracks', i]`, validated against the full `Track` schema. `addTrack` uses it to overwrite the reused pool slot with `freshTrack(true)` in ONE op (no op-storm, one undo entry). The audio engine gains a whole-track case that rebuilds the slot via the existing `syncTrackToEngine`. Delete is unchanged.

**Tech Stack:** TypeScript, Vue 3 (reactive store), Zod (schema), Vitest. Monorepo: `@fiddle/shared` (sync contract), `@fiddle/client` (UI/audio), `@fiddle/server` (op validation/broadcast).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-20-atomic-track-reset-design.md`.
- Pool model: `TRACK_POOL_SIZE = 32`, `DEFAULT_ENABLED_TRACKS = 4` (fresh project enables slots 0–3).
- **Delete stays unchanged** — the single non-destructive `['tracks', i, 'enabled'] → false` op.
- **Full reset** — the new track is `freshTrack(true)` (engineType `synth`, name `''`, patternLength 16, mixer defaults, all 10 engine slices default, all 64 steps blank, `enabled: true`).
- **Always reset on add** — even a pristine reused slot is overwritten; one uniform code path, no is-dirty branch.
- The reset must be **one atomic op** — never a per-leaf diff (a >200-leaf burst trips the 200-token rate limiter → nack → rollback → silent data loss).
- Never work on `main`; this plan runs on branch `fix/add-track-resets-slot` (already created).
- Every commit ends with these two trailer lines (exactly):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
  ```
- Test commands per package: `npm -w @fiddle/shared run test`, `npm -w @fiddle/client run test`, `npm -w @fiddle/server run test`. Typecheck: `npm -w <pkg> run typecheck` (or the repo's `npm run typecheck`). Browser verify uses the already-running `npm run dev:obs` (LOCAL Docker DB) — NEVER `npm run dev`.

---

### Task 1: Accept-list allows the atomic whole-track write (shared)

**Files:**
- Modify: `packages/shared/src/project/accept-list.ts` (add a `PATTERNS` entry; extend `resolveLeafSchema`)
- Test: `packages/shared/src/project/accept-list.test.ts`

**Interfaces:**
- Produces: the wire path `tracks.<i>` (array form `['tracks', i]`) is writable and validates its value against `Schemas.Track`. Out-of-range indices still fail via `indicesInRange`. Consumed by Task 2 (server, generically) and Task 4 (client dispatch).

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/project/accept-list.test.ts`. First add the import near the top (alongside the existing `import { identityTrackOrder } from './index.js';`):

```ts
import { freshTrack } from './factory.js';
```

Then add this describe block at the end of the file:

```ts
describe('whole-track atomic write (reset-on-add)', () => {
  it('marks tracks.<i> writable (the one non-leaf track path)', () => {
    expect(pathIsWritable('tracks.0')).toBe(true);
    expect(pathIsWritable('tracks.31')).toBe(true);
  });

  it('accepts a valid whole Track value in range', () => {
    expect(validatePathAndValue('tracks.0', freshTrack(true))).toEqual({ ok: true });
    expect(validatePathAndValue('tracks.5', freshTrack(false))).toEqual({ ok: true });
  });

  it('rejects an out-of-range track index (path.invalid)', () => {
    const r = validatePathAndValue('tracks.32', freshTrack(true));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('path.invalid');
  });

  it('rejects a malformed track value (value.invalid)', () => {
    const r = validatePathAndValue('tracks.0', { enabled: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value.invalid');
  });

  it('still rejects whole-ENGINE writes (leaf-only rule holds below the track)', () => {
    expect(pathIsWritable('tracks.0.engines.synth')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @fiddle/shared run test -- accept-list`
Expected: FAIL — `pathIsWritable('tracks.0')` is `false` and `validatePathAndValue('tracks.0', …)` returns `path.invalid` ("path not writable") because no pattern matches and `resolveLeafSchema` returns `null`.

- [ ] **Step 3: Add the accept-list pattern**

In `packages/shared/src/project/accept-list.ts`, in the `PATTERNS` array, immediately after the `['trackOrder'],` entry, add:

```ts
  // Whole-track atomic write — the ONLY non-leaf track write. "Add track" uses
  // it to reset a reused pool slot to a fresh track in ONE op; a per-leaf reset
  // would be an op-storm past the rate limiter (nack → rollback → data loss).
  // The value is validated against the full Track schema (resolveLeafSchema).
  ['tracks', '*'],
```

- [ ] **Step 4: Resolve the whole-track schema**

In the same file, in `resolveLeafSchema`, immediately before the line `const trackKey = tokens[2];` (just after the `if (!/^\d+$/.test(tokens[1])) return null;` guard), add:

```ts
  // Whole-track atomic write: path is exactly `tracks.<i>` (length 2). Validate
  // the entire Track object.
  if (tokens.length === 2) return Schemas.Track;
```

(`Schemas.Track` already exists — see `schema.ts`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm -w @fiddle/shared run test -- accept-list`
Expected: PASS (all new cases green; existing cases including "rejects whole-object writes (e.g. tracks.0.engines.synth)" still pass — that path is length 4, unaffected).

- [ ] **Step 6: Full shared suite + typecheck**

Run: `npm -w @fiddle/shared run test` then `npm -w @fiddle/shared run typecheck`
Expected: all pass. (The new `['tracks','*']` pattern is length-2-only; no other length-2 `tracks.*` path exists, so nothing else changes.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/project/accept-list.ts packages/shared/src/project/accept-list.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): allow the atomic whole-track set op in the accept-list

`tracks.<i>` becomes writable, validated against the full Track schema — the
one deliberate exception to leaf-only track writes. Enables reset-on-add to
replace a reused pool slot in ONE op instead of an op-storm of leaf writes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 2: Server accepts and bounds-checks the whole-track op (server, test-only)

**Files:**
- Test: `packages/server/src/sync/ConnectionHandler.test.ts`

No server source change — `ConnectionHandler` validates every `set` via the shared `validatePathAndValue` (Task 1) and applies via the generic `setDeep`. This task locks that end-to-end behavior for the data-loss-sensitive path.

**Interfaces:**
- Consumes: Task 1's accept-list change (shared, already built into the server).

- [ ] **Step 1: Write the failing tests**

In `packages/server/src/sync/ConnectionHandler.test.ts`, add `freshTrack` to the existing `@fiddle/shared` import on line 2:

```ts
import { PROJECT_SCHEMA_VERSION, HANDLES, freshProject, freshTrack, TRACK_POOL_SIZE, STEP_BUFFER_SIZE } from '@fiddle/shared';
```

Then add this describe block inside the top-level `describe('ConnectionHandler', () => { … })` (e.g. just before its closing `});`):

```ts
  describe('whole-track atomic write', () => {
    it('applies an in-range whole-track set and broadcasts it (no nack)', async () => {
      const sockA = makeMockSocket();
      const sockB = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', sockA);
      pool.add('room1', sockB);
      const handlerA = new ConnectionHandler('room1', sockA, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      const handlerB = new ConnectionHandler('room1', sockB, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handlerA.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      await handlerB.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      sockA.sent.length = 0;
      sockB.sent.length = 0;

      // Slot 5 is disabled in a fresh project; reset it to a fresh ENABLED track.
      await handlerA.onMessage({ v: 1, type: 'set', clientSeq: 1, path: ['tracks', 5], value: freshTrack(true) });

      expect(sockA.sent.find((m) => m.type === 'nack')).toBeUndefined();
      expect((await store.peekProject('room1'))?.tracks[5].enabled).toBe(true);
      // Peer B receives the broadcast whole-track set.
      const bcast = sockB.sent.find((m) => m.type === 'set' && JSON.stringify(m.path) === JSON.stringify(['tracks', 5]));
      expect(bcast).toBeDefined();
    });

    it('nacks an out-of-range whole-track set (path.invalid)', async () => {
      const sock = makeMockSocket();
      const pool = new FakePool();
      pool.add('room1', sock);
      const handler = new ConnectionHandler('room1', sock, store, pool, noopLog, rejectAll, new InMemoryProfileStore());
      await handler.onMessage({ v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
      sock.sent.length = 0;

      await handler.onMessage({ v: 1, type: 'set', clientSeq: 1, path: ['tracks', TRACK_POOL_SIZE], value: freshTrack(true) });

      const nack = sock.sent.find((m) => m.type === 'nack');
      expect(nack).toBeDefined();
      if (nack && nack.type === 'nack') expect(nack.code).toBe('path.invalid');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @fiddle/server run test -- ConnectionHandler`
Expected: the in-range test FAILS — before Task 1's shared change is picked up, the server nacks `tracks.5` as `path.invalid` (so `nack` is defined and `tracks[5].enabled` stays `false`). If Task 1 is already merged into the shared build the in-range test may pass; the out-of-range test must pass regardless. If BOTH already pass, note it and continue (the tests still lock the behavior).

- [ ] **Step 3: (No implementation — server is generic.)**

If the in-range test fails only because the built `@fiddle/shared` is stale, rebuild shared: `npm -w @fiddle/shared run build` (or rely on the workspace's source resolution) and re-run. No server source edit is expected. If the server genuinely rejects a valid whole-track op after Task 1, STOP and investigate (do not patch around it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm -w @fiddle/server run test -- ConnectionHandler`
Expected: PASS (both new cases).

- [ ] **Step 5: Full server suite + typecheck**

Run: `npm -w @fiddle/server run test` then `npm -w @fiddle/server run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/sync/ConnectionHandler.test.ts
git commit -m "$(cat <<'EOF'
test(server): lock whole-track set — applies+broadcasts in range, nacks OOB

End-to-end coverage for the data-loss-sensitive path: the generic set handler
accepts an in-range whole-track op (validated by the shared accept-list) and
nacks an out-of-range index. No server source change — validation is shared.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 3: AudioEngine rebuilds the slot on a whole-track set (client)

**Files:**
- Modify: `packages/client/src/audio/AudioEngine.ts` (the `onCommand` handler)
- Test: `packages/client/src/audio/AudioEngine.test.ts`

**Interfaces:**
- Consumes: the applied-command `{ kind: 'set', path: ['tracks', i], value: Track }` the bus emits on a whole-track write.
- Produces: on such a command, the slot's engine is rebuilt from live state (`syncTrackToEngine(i)`) and mixer gains re-derived (`updateMixerGains()`).

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/audio/AudioEngine.test.ts`, add `freshTrack` to the existing import on line 3:

```ts
import { freshProject, freshTrack, type Project } from '../project';
```

Then add these tests inside the `describe('AudioEngine', …)` block (e.g. after the "engineType set swaps the slot engine" test):

```ts
  it('a whole-track set rebuilds an enabled slot from the new state (kick → fresh synth)', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    set(['tracks', 0, 'engineType'], 'kick');
    expect(state.engines[0]!.engineType).toBe('kick');
    set(['tracks', 0], freshTrack(true)); // reset to a fresh (synth) track
    expect(state.engines[0]!.engineType).toBe('synth');
  });

  it('a whole-track set on a disabled slot builds its engine (fresh + enabled)', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    expect(state.engines[10]).toBeUndefined(); // slot 10 disabled in a fresh project
    set(['tracks', 10], freshTrack(true));
    expect(state.engines[10]).toBeDefined();
    expect(state.engines[10]!.engineType).toBe('synth');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @fiddle/client run test -- AudioEngine`
Expected: FAIL — a length-2 path currently falls through `switch (p[2])` to `default` (no reaction): slot 0 stays `kick`; slot 10's engine stays `undefined`.

- [ ] **Step 3: Add the whole-track case**

In `packages/client/src/audio/AudioEngine.ts`, inside `onCommand`, immediately after the line `const i = p[1];` and before `switch (p[2]) {`, add:

```ts
      // Whole-track atomic write (reset-on-add): path is exactly ['tracks', i]
      // with no field key — rebuild the slot from the new state, the same
      // reaction engineType / enabled / `replace` use.
      if (p.length === 2) {
        syncTrackToEngine(i);
        updateMixerGains();
        return;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm -w @fiddle/client run test -- AudioEngine`
Expected: PASS (both new cases; existing AudioEngine tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/audio/AudioEngine.ts packages/client/src/audio/AudioEngine.test.ts
git commit -m "$(cat <<'EOF'
feat(client/audio): rebuild the slot engine on a whole-track set

A length-2 ['tracks', i] applied-command now runs syncTrackToEngine + mixer
re-derive (same as engineType/enabled/replace), so reset-on-add re-inits the
reused slot's engine from the fresh track.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 4: `addTrack` resets the reused slot atomically (client) + browser verify

**Files:**
- Modify: `packages/client/src/app/synthContext.ts` (import `freshTrack`; add optional `gestureEnd` override to the local `dispatchLocal`; rewrite `addTrack`)
- Test: `packages/client/src/app/synthContext.test.ts` (update the existing addTrack test; add regression + undo tests)

**Interfaces:**
- Consumes: Task 1 (writable `['tracks', i]`), Task 3 (audio rebuild), `freshTrack` from `../project`.
- Produces: `addTrack()` emits exactly one whole-track `set` op (value = a fresh enabled track) plus the existing `trackOrder` move-to-end op; the reused slot becomes blank; Undo restores the deleted track.

- [ ] **Step 1: Update the existing test + write the new failing tests**

In `packages/client/src/app/synthContext.test.ts`:

**(a)** Replace the existing test (currently "addTrack emits an enabled op via dispatch"):

```ts
  it('addTrack emits ONE whole-track reset op (fresh + enabled), not a bare enabled op', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    const firstDisabled = ctx.project.tracks.findIndex((t: any) => !t.enabled);
    ctx.addTrack();
    const trackOp = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', firstDisabled]));
    expect(trackOp).toBeDefined();
    expect(trackOp.value.enabled).toBe(true);
    expect(trackOp.value.engineType).toBe('synth');
    // No per-leaf enabled op any more (that path resurrected the deleted track).
    const leafEnabled = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', firstDisabled, 'enabled']));
    expect(leafEnabled).toBeUndefined();
  });
```

**(b)** Add a regression test + an undo test in the same file (place them in a new describe near the other track tests):

```ts
describe('add-track reset-on-add (F-bug: add resurrects the deleted track)', () => {
  it('add after delete gives a BLANK track, not the deleted one', async () => {
    const { ctx } = makeCtx();
    // Dirty slot 3 (a default-enabled track): a note + a non-default engine.
    ctx.dispatchLocal(['tracks', 3, 'steps', 0, 'note'], 'C');
    ctx.dispatchLocal(['tracks', 3, 'engineType'], 'kick');
    ctx.removeTrack(3);           // disable slot 3 (enabledCount 4 → 3, allowed)
    ctx.addTrack();               // reuses the lowest disabled slot = 3
    expect(ctx.project.tracks[3].enabled).toBe(true);
    expect(ctx.project.tracks[3].engineType).toBe('synth');   // reset, not kick
    expect(ctx.project.tracks[3].steps[0].note).toBeNull();   // blank, not 'C'
  });

  it('undo of add restores the deleted track (content + disabled state)', async () => {
    const { runtime, ctx } = makeCtx();
    ctx.dispatchLocal(['tracks', 3, 'steps', 0, 'note'], 'C');
    await nextTick();             // seal as its own undo entry
    ctx.removeTrack(3);
    await nextTick();
    ctx.addTrack();
    await nextTick();             // seal the add (reset + trackOrder) as one entry
    expect(ctx.project.tracks[3].steps[0].note).toBeNull();   // blank after add
    runtime.history.undo();       // undo ONLY the add
    expect(ctx.project.tracks[3].enabled).toBe(false);        // deleted again
    expect(ctx.project.tracks[3].steps[0].note).toBe('C');    // content restored
  });
});
```

(`makeCtx`, `bootWithFakeSocket`, and the `nextTick` import already exist in this file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @fiddle/client run test -- synthContext`
Expected: FAIL — `addTrack` still emits `['tracks', firstDisabled, 'enabled'] = true` (no whole-track op), so the reused slot keeps its old content (`engineType` `kick`, note `'C'`), and the whole-track op assertions are undefined.

- [ ] **Step 3: Import `freshTrack`**

In `packages/client/src/app/synthContext.ts`, extend the existing import on line 4:

```ts
import { type EngineType, freshProject, freshTrack } from '../project';
```

- [ ] **Step 4: Add an optional `gestureEnd` override to the local `dispatchLocal`**

Replace the local `dispatchLocal` function (currently lines ~37–44) with:

```ts
  function dispatchLocal(path: Path, value: unknown, gestureEndOverride?: boolean): void {
    const gestureEnd = gestureEndOverride ?? gestureEndForLeaf(String(path[path.length - 1]));
    const prior = getDeep(project as unknown as Record<string, unknown>, path);
    // toRaw: object leaves (trackOrder, a whole track) must be captured raw so
    // undo's identity/deepEqual comparisons (see AppRuntime getLiveValue) hold.
    const priorValue = typeof prior === 'object' && prior !== null ? toRaw(prior) : prior;
    bus.dispatchLocal({ path, value, priorValue, gestureEnd });
  }
```

(The new third parameter is optional — every existing caller is unaffected.)

- [ ] **Step 5: Rewrite `addTrack`**

Replace `addTrack` (currently lines ~172–178) with:

```ts
  const addTrack = (): void => {
    const idx = project.tracks.findIndex(t => !t.enabled);
    if (idx === -1) return;
    // Overwrite the reused slot with a fresh, ENABLED track in ONE atomic op.
    // freshTrack(true).enabled === true, so this enables AND clears together:
    // a per-leaf reset would op-storm past the rate limiter, and a bare
    // enabled=true would resurrect the deleted track's content. gestureEnd=true
    // (discrete action → flush immediately). dispatchLocal captures the prior
    // (the deleted track) for nack rollback + undo. Both dispatches share one
    // synchronous task → ONE undo entry (burst rule).
    dispatchLocal(['tracks', idx], freshTrack(true), true);
    const next = moveTrackBefore(project.trackOrder, idx, null);
    if (!ordersEqual(next, project.trackOrder)) dispatchLocal(['trackOrder'], next);
  };
```

(`removeTrack` is unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm -w @fiddle/client run test -- synthContext`
Expected: PASS (updated addTrack test + both new tests).

- [ ] **Step 7: Full client suite + typecheck**

Run: `npm -w @fiddle/client run test` then `npm -w @fiddle/client run typecheck`
Expected: all pass (no other test depended on addTrack's old enabled-op behavior — verified: only the one test referenced it).

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/app/synthContext.ts packages/client/src/app/synthContext.test.ts
git commit -m "$(cat <<'EOF'
fix(client): add-track resets the reused pool slot to a fresh track

addTrack now overwrites the lowest disabled slot with freshTrack(true) in one
atomic whole-track op (+ the existing trackOrder move), instead of only
flipping enabled=true — which resurrected the just-deleted track's steps and
sound. Delete stays non-destructive; Undo restores the deleted track. One
undo entry per add.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

- [ ] **Step 9: Browser verification (mandatory, live room)**

Rebuild worklets are NOT needed (no worklet/DSP change), but the client bundle must pick up the source change — the running `dev:obs` Vite server HMRs `synthContext.ts`/`AudioEngine.ts` automatically. Using Playwright MCP against the already-running local app (`http://localhost:5173`):

1. Open a room (or create one). Ensure ≥2 tracks so delete is allowed.
2. On some track, place a note (click a step) and switch its engine — make it audibly distinct.
3. Delete that track (the remove control). Then click **+ add track**.
4. **Confirm the new track is BLANK** — default `synth` engine, no steps, default sound — NOT the deleted track.
5. Press **Undo** — confirm the deleted track reappears with its note + engine.
6. Reload the page (or check a second browser tab in the same room) — confirm the blank track persists (the atomic op synced).
7. Confirm the browser console is clean (no errors/warnings beyond pre-existing favicon 404s).

Report observations. Close the browser/tab when done (AGENTS.md cleanup rule).

---

## Self-Review

**1. Spec coverage:**
- Accept-list whole-track pattern + Track-schema validation → Task 1. ✓
- Audio whole-track rebuild → Task 3. ✓
- `addTrack` atomic reset + prior for undo/rollback + trackOrder → Task 4. ✓
- Delete unchanged → Task 4 (explicitly untouched) + Global Constraints. ✓
- Server bounds/accept (spec testing strategy) → Task 2. ✓
- Unit tests (add-after-delete blank; undo of add restores; delete+undo restores; accept-list; audio) → Tasks 1/3/4. ✓ (Delete+undo is existing covered behavior; the new undo test focuses on the add path, which is the changed surface.)
- Browser verify (reproduce report; peer/reload sync) → Task 4 Step 9. ✓
- "Always reset on add" / "full reset" behavior decisions → encoded in `freshTrack(true)` (Task 4). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**3. Type consistency:** `freshTrack(enabled?: boolean)` used consistently (`freshTrack(true)` for enabled resets). `dispatchLocal(path, value, gestureEndOverride?)` — the added third arg is optional and only Task 4's `addTrack` passes it. `Schemas.Track`, `syncTrackToEngine(i)`, `updateMixerGains()`, `runtime.history.undo()` all match the real symbols verified in the source. ✓
