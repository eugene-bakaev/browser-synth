# Track Reordering (Drag & Drop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users reorder tracks by dragging track cards in the overview grid; the order syncs to collaborators, persists in session snapshots and saved files, and is undoable.

**Architecture:** A new top-level `Project.trackOrder: number[]` — a permutation of pool indices `0..31` in display order. The fixed 32-slot `tracks[]` pool never moves (track identity = pool index stays the sync/audio invariant); the UI sorts through the indirection. A drag emits ONE atomic `set ['trackOrder']` op (same shape as the `bpm` leaf), LWW-resolved like every other leaf.

**Tech Stack:** TypeScript strict, Zod (shared schema), Vue 3 `<script setup>`, native HTML5 drag-and-drop (no new dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-track-reorder-design.md`

## Global Constraints

- Work on branch `feat/track-reorder` (already exists, carries the spec commit). NEVER commit on `main`. Do not merge without explicit user instruction.
- Merge gate: `npm run typecheck && npm test && npm run build` all green (run from repo root).
- Tests: logic, composables, and pure helpers only. Do NOT mount `.vue` files in tests.
- Commits: only the files relevant to the change (never `git add -A`). End every commit message with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- `TRACK_POOL_SIZE` is 32 (import from shared `constants.js` — never hardcode).
- Browser verification uses `npm run dev:obs` (LOCAL Docker DB). NEVER `npm run dev` (production Supabase — data-loss risk). If the dev server is already running (EADDRINUSE), REUSE it — never kill processes you didn't start.
- Version-skew stance (no schema version bump): `trackOrder` is OPTIONAL in `ProjectSchema` (the server bulk-load path parses BEFORE normalizing — a required field would nack old clients' `load`); `normalizeProject` heals absence to the identity permutation at every boundary. An old server nacks `set ['trackOrder']` as `path.invalid` → the client outbox rolls the local reorder back; safe, self-healing skew.
- `trackOrder` is deliberately NOT included in `enqueueWholeProjectDiff` (the no-bulk fallback for old servers on New/Open): its diff walker skips arrays today, and an old server would nack the path anyway. The bulk `load` path carries the whole project including `trackOrder`.

---

### Task 1: Shared order helpers (`order.ts`)

**Files:**
- Create: `packages/shared/src/project/order.ts`
- Create: `packages/shared/src/project/order.test.ts`
- Modify: `packages/shared/src/project/index.ts` (add export line)

**Interfaces:**
- Consumes: `TRACK_POOL_SIZE` from `./constants.js`
- Produces (used by Tasks 2–3, 6–9):
  - `identityTrackOrder(): number[]`
  - `isValidTrackOrder(v: unknown): v is number[]`
  - `coerceTrackOrder(v: unknown): number[]`
  - `ordersEqual(a: readonly number[], b: readonly number[]): boolean`
  - `moveTrackBefore(order: readonly number[], moved: number, anchor: number | null): number[]`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/project/order.test.ts
import { describe, it, expect } from 'vitest';
import {
  identityTrackOrder,
  isValidTrackOrder,
  coerceTrackOrder,
  ordersEqual,
  moveTrackBefore,
} from './order.js';
import { TRACK_POOL_SIZE } from './constants.js';

describe('identityTrackOrder', () => {
  it('is 0..TRACK_POOL_SIZE-1 in order', () => {
    const o = identityTrackOrder();
    expect(o).toHaveLength(TRACK_POOL_SIZE);
    expect(o[0]).toBe(0);
    expect(o[TRACK_POOL_SIZE - 1]).toBe(TRACK_POOL_SIZE - 1);
  });
  it('returns a fresh array each call', () => {
    expect(identityTrackOrder()).not.toBe(identityTrackOrder());
  });
});

describe('isValidTrackOrder', () => {
  it('accepts the identity permutation', () => {
    expect(isValidTrackOrder(identityTrackOrder())).toBe(true);
  });
  it('accepts a shuffled permutation', () => {
    const o = identityTrackOrder().reverse();
    expect(isValidTrackOrder(o)).toBe(true);
  });
  it('rejects non-arrays, wrong length, duplicates, out-of-range, floats', () => {
    expect(isValidTrackOrder(undefined)).toBe(false);
    expect(isValidTrackOrder(null)).toBe(false);
    expect(isValidTrackOrder('0,1,2')).toBe(false);
    expect(isValidTrackOrder(identityTrackOrder().slice(1))).toBe(false);
    const dupes = identityTrackOrder(); dupes[1] = 0;
    expect(isValidTrackOrder(dupes)).toBe(false);
    const oor = identityTrackOrder(); oor[0] = TRACK_POOL_SIZE;
    expect(isValidTrackOrder(oor)).toBe(false);
    const float = identityTrackOrder(); float[0] = 0.5;
    expect(isValidTrackOrder(float)).toBe(false);
  });
});

describe('coerceTrackOrder', () => {
  it('passes a valid order through by reference', () => {
    const o = identityTrackOrder().reverse();
    expect(coerceTrackOrder(o)).toBe(o);
  });
  it('heals anything invalid to identity', () => {
    expect(coerceTrackOrder(undefined)).toEqual(identityTrackOrder());
    expect(coerceTrackOrder([1, 1, 1])).toEqual(identityTrackOrder());
  });
});

describe('ordersEqual', () => {
  it('true for same content, false for different', () => {
    expect(ordersEqual(identityTrackOrder(), identityTrackOrder())).toBe(true);
    expect(ordersEqual(identityTrackOrder(), identityTrackOrder().reverse())).toBe(false);
  });
});

describe('moveTrackBefore', () => {
  // Small orders keep the cases readable; the helper is length-agnostic.
  it('moves earlier (before a later anchor)', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 0, 3)).toEqual([1, 2, 0, 3]);
  });
  it('moves later (before an earlier anchor)', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 3, 1)).toEqual([0, 3, 1, 2]);
  });
  it('null anchor moves to the end', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 1, null)).toEqual([0, 2, 3, 1]);
  });
  it('moving before itself is a content no-op (fresh array)', () => {
    const order = [0, 1, 2, 3];
    const next = moveTrackBefore(order, 2, 2);
    expect(next).toEqual(order);
    expect(next).not.toBe(order);
  });
  it('moving before its current successor is a content no-op', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 1, 2)).toEqual([0, 1, 2, 3]);
  });
  it('unknown anchor falls back to end', () => {
    expect(moveTrackBefore([0, 1, 2, 3], 0, 99)).toEqual([1, 2, 3, 0]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/src/project/order.test.ts`
Expected: FAIL — `Cannot find module './order.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/project/order.ts
//
// Track display-order helpers. `trackOrder` is a permutation of pool indices
// (0..TRACK_POOL_SIZE-1): position in the array = display position, value =
// pool index. The tracks pool itself NEVER moves — track identity is the pool
// index everywhere (sync paths, engines, selection); only presentation order
// changes. See docs/superpowers/specs/2026-07-15-track-reorder-design.md.

import { TRACK_POOL_SIZE } from './constants.js';

export function identityTrackOrder(): number[] {
  return Array.from({ length: TRACK_POOL_SIZE }, (_, i) => i);
}

export function isValidTrackOrder(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === TRACK_POOL_SIZE &&
    v.every((n) => Number.isInteger(n) && n >= 0 && n < TRACK_POOL_SIZE) &&
    new Set(v).size === TRACK_POOL_SIZE
  );
}

// Repair-path dual of coerceBpm: a valid order rides through by reference,
// anything else heals to identity. Shared by normalizeProject (sync/server
// boundary) and reconcileWithDefaults (client offline boundary).
export function coerceTrackOrder(v: unknown): number[] {
  return isValidTrackOrder(v) ? v : identityTrackOrder();
}

export function ordersEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Move `moved` so it sits immediately before `anchor` (null = end of the
// order). Anchoring on a pool index (not a display position) keeps the math
// independent of which slots are enabled: disabled slots keep their relative
// positions. Always returns a fresh array; callers skip dispatch when
// ordersEqual(next, current).
export function moveTrackBefore(
  order: readonly number[],
  moved: number,
  anchor: number | null,
): number[] {
  if (moved === anchor) return [...order];
  const rest = order.filter((p) => p !== moved);
  const at = anchor === null ? rest.length : rest.indexOf(anchor);
  rest.splice(at === -1 ? rest.length : at, 0, moved);
  return rest;
}
```

- [ ] **Step 4: Export from the project barrel**

In `packages/shared/src/project/index.ts`, after the `normalize.js` export line, add:

```ts
export {
  identityTrackOrder,
  isValidTrackOrder,
  coerceTrackOrder,
  ordersEqual,
  moveTrackBefore,
} from './order.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/src/project/order.test.ts`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/project/order.ts packages/shared/src/project/order.test.ts packages/shared/src/project/index.ts
git commit -m "feat(shared): track display-order helpers (identity/validate/coerce/move)"
```

---

### Task 2: `Project.trackOrder` — type, schema, factory

**Files:**
- Modify: `packages/shared/src/project/types.ts` (Project interface, ~line 59)
- Modify: `packages/shared/src/project/schema.ts` (~line 214 TrackSchema area + Schemas map ~line 239)
- Modify: `packages/shared/src/project/factory.ts` (freshProject, ~line 60)
- Test: `packages/shared/src/project/schema.test.ts`, `packages/shared/src/project/factory.test.ts`

**Interfaces:**
- Consumes: `identityTrackOrder` from Task 1.
- Produces: `Project.trackOrder: number[]` (required in TS — post-normalize invariant); `TrackOrderSchema` exported via `Schemas.TrackOrder`; `ProjectSchema` field `trackOrder` OPTIONAL (see Global Constraints: server parses before normalizing).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/project/schema.test.ts` (match the file's existing import style):

```ts
describe('trackOrder', () => {
  it('freshProject parses (identity order)', () => {
    expect(ProjectSchema.safeParse(freshProject()).success).toBe(true);
  });
  it('a shuffled permutation parses', () => {
    const p = freshProject();
    p.trackOrder = [...p.trackOrder].reverse();
    expect(ProjectSchema.safeParse(p).success).toBe(true);
  });
  it('a project WITHOUT trackOrder still parses (old-client bulk load)', () => {
    const p = freshProject() as Record<string, unknown>;
    delete p.trackOrder;
    expect(ProjectSchema.safeParse(p).success).toBe(true);
  });
  it('duplicates are rejected', () => {
    const p = freshProject();
    p.trackOrder = [...p.trackOrder];
    p.trackOrder[1] = 0;
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });
  it('wrong length is rejected', () => {
    const p = freshProject();
    p.trackOrder = p.trackOrder.slice(1);
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });
  it('out-of-range index is rejected', () => {
    const p = freshProject();
    p.trackOrder = [...p.trackOrder];
    p.trackOrder[0] = TRACK_POOL_SIZE;
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });
});
```

Append to `packages/shared/src/project/factory.test.ts`:

```ts
it('freshProject carries the identity trackOrder', () => {
  expect(freshProject().trackOrder).toEqual(identityTrackOrder());
});
```

(Add any missing imports — `ProjectSchema`, `freshProject`, `TRACK_POOL_SIZE`, `identityTrackOrder` — to each test file's import block.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/src/project/schema.test.ts packages/shared/src/project/factory.test.ts`
Expected: FAIL — `trackOrder` missing from type / schema strips or rejects.

- [ ] **Step 3: Implement**

`types.ts` — inside `interface Project` after `bpm: number;`:

```ts
  // Display order: a permutation of pool indices (0..TRACK_POOL_SIZE-1).
  // Position = display position, value = pool index. Presentation ONLY — the
  // tracks pool never moves and every sync path keeps addressing pool indices.
  // Healed to identity by normalizeProject; optional on the wire (old
  // payloads), required here (post-normalize invariant).
  trackOrder: number[];
```

`schema.ts` — after `TrackSchema` (before `ProjectSchema`):

```ts
// Whole-array leaf (the accept-list allows `set ['trackOrder']` only as one
// atomic write — per-element writes could create a duplicated index mid-flight).
export const TrackOrderSchema = z
  .array(z.number().int().min(0).max(TRACK_POOL_SIZE - 1))
  .length(TRACK_POOL_SIZE)
  .refine((a) => new Set(a).size === a.length, {
    message: 'trackOrder must be a permutation of pool indices',
  });
```

In `ProjectSchema`, after `bpm`:

```ts
  // Optional on the wire: the server's bulk-load path parses BEFORE
  // normalizeProject runs, so an old client's payload (no trackOrder) must
  // still parse. normalizeProject heals absence to identity right after.
  trackOrder: TrackOrderSchema.optional(),
```

In the `Schemas` map, after `Track: TrackSchema,`:

```ts
  TrackOrder: TrackOrderSchema,
```

`factory.ts` — import `identityTrackOrder` from `./order.js`; in `freshProject()` after `bpm: DEFAULT_BPM,`:

```ts
    trackOrder: identityTrackOrder(),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run packages/shared/src/project/schema.test.ts packages/shared/src/project/factory.test.ts && npm run typecheck`
Expected: tests PASS. Typecheck will FAIL in places that build a `Project` literal without `trackOrder` — expected; the failures are fixed by Tasks 3–6 (normalize, codec, client storage). If any OTHER site constructs a bare `Project` (search: `rg -n "schemaVersion: PROJECT_SCHEMA_VERSION|schemaVersion: 2" packages`), fix it by adding `trackOrder: identityTrackOrder()` or routing through `freshProject()`. Do not commit with typecheck red — if red persists beyond the files Tasks 3–6 own, fix those sites in THIS task.

- [ ] **Step 5: Commit** (only once `npm run typecheck` is green — fold in the trivial `trackOrder: identityTrackOrder()` additions Step 4 surfaced, including normalize.ts/snapshot-codec.ts if the compiler demands them now; Tasks 3–4 then upgrade those from "compiles" to "heals correctly + tested")

```bash
git add packages/shared/src
git commit -m "feat(shared): Project.trackOrder — permutation type, Zod schema, identity default"
```

---

### Task 3: `normalizeProject` heals `trackOrder`

**Files:**
- Modify: `packages/shared/src/project/normalize.ts` (`isAlreadyValid` ~line 141, `normalizeProject` return ~line 133)
- Test: `packages/shared/src/project/normalize.test.ts`

**Interfaces:**
- Consumes: `isValidTrackOrder`, `coerceTrackOrder` (Task 1).
- Produces: every `normalizeProject` output has a valid `trackOrder`; already-valid projects still return by reference (fast path).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/project/normalize.test.ts`:

```ts
describe('trackOrder healing', () => {
  it('missing trackOrder heals to identity', () => {
    const p = freshProject() as Record<string, unknown>;
    delete p.trackOrder;
    const out = normalizeProject(p as unknown as Project);
    expect(out.trackOrder).toEqual(identityTrackOrder());
  });
  it('invalid trackOrder (duplicates) heals to identity', () => {
    const p = freshProject();
    p.trackOrder = p.trackOrder.map(() => 0);
    expect(normalizeProject(p).trackOrder).toEqual(identityTrackOrder());
  });
  it('a valid shuffled order survives by reference', () => {
    const p = freshProject();
    const shuffled = [...p.trackOrder].reverse();
    p.trackOrder = shuffled;
    expect(normalizeProject(p).trackOrder).toBe(shuffled);
  });
  it('fast path: a fully valid project returns by reference', () => {
    const p = normalizeProject(freshProject());
    expect(normalizeProject(p)).toBe(p);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/src/project/normalize.test.ts`
Expected: the `missing trackOrder heals` test FAILS (fast path or spread passes the hole through).

- [ ] **Step 3: Implement**

In `normalize.ts`, import from `./order.js`:

```ts
import { isValidTrackOrder, coerceTrackOrder } from './order.js';
```

In `isAlreadyValid`, add a conjunct:

```ts
    isValidTrackOrder(project.trackOrder) &&
```

In the `normalizeProject` return object, after `bpm: coerceBpm(project.bpm),`:

```ts
    trackOrder: coerceTrackOrder(project.trackOrder),
```

Also extend the doc comment's invariants list with one line: `//   - trackOrder is a permutation of 0..TRACK_POOL_SIZE-1 (healed to identity)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/shared/src/project/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/normalize.ts packages/shared/src/project/normalize.test.ts
git commit -m "feat(shared): normalizeProject heals trackOrder to a valid permutation"
```

---

### Task 4: Snapshot codec round-trips `trackOrder`

**Files:**
- Modify: `packages/shared/src/project/snapshot-codec.ts` (`StoredProject` ~line 40, `unpackProject` ~line 77, `packProject` ~line 94)
- Test: `packages/shared/src/project/snapshot-codec.test.ts`

**Interfaces:**
- Consumes: `Project.trackOrder` (Task 2), normalize healing (Task 3).
- Produces: DB-persisted snapshots carry `trackOrder`; legacy stored rows (no field) unpack to identity.

**Why this task exists:** `packProject` builds `{schemaVersion, bpm, tracks}` explicitly — without this task the reorder would silently vanish on every server persist (reload round-trip would lose it).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/project/snapshot-codec.test.ts`:

```ts
describe('trackOrder round-trip', () => {
  it('pack keeps the order; unpack restores it', () => {
    const p = normalizeProject(freshProject());
    p.trackOrder = [...p.trackOrder].reverse();
    const stored = packProject(p);
    expect(stored.trackOrder).toEqual(p.trackOrder);
    expect(unpackProject(stored).trackOrder).toEqual(p.trackOrder);
  });
  it('legacy stored rows without trackOrder unpack to identity', () => {
    const stored = packProject(normalizeProject(freshProject())) as Record<string, unknown>;
    delete stored.trackOrder;
    expect(unpackProject(stored).trackOrder).toEqual(identityTrackOrder());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: FAIL — `stored.trackOrder` is `undefined` after pack.

- [ ] **Step 3: Implement**

`StoredProject` interface — after `bpm: number;`:

```ts
  // Optional: rows persisted before the reorder feature lack it; unpack routes
  // through normalizeProject which heals absence to identity.
  trackOrder?: number[];
```

`unpackProject` — include the field in the object handed to `normalizeProject` (extend the destructured type with `trackOrder?: unknown` and pass it through):

```ts
  return normalizeProject({
    schemaVersion: s.schemaVersion,
    bpm: s.bpm,
    trackOrder: (s as { trackOrder?: unknown }).trackOrder,
    tracks,
  } as Project);
```

`packProject` — return statement becomes:

```ts
  return { schemaVersion: project.schemaVersion, bpm: project.bpm, trackOrder: project.trackOrder, tracks };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/snapshot-codec.ts packages/shared/src/project/snapshot-codec.test.ts
git commit -m "feat(shared): snapshot codec persists trackOrder (legacy rows heal to identity)"
```

---

### Task 5: Accept-list allows atomic `set ['trackOrder']`

**Files:**
- Modify: `packages/shared/src/project/accept-list.ts` (PATTERNS ~line 32, `resolveLeafSchema` top-level block ~line 175)
- Test: `packages/shared/src/project/accept-list.test.ts`

**Interfaces:**
- Consumes: `Schemas.TrackOrder` (Task 2).
- Produces: `validatePathAndValue('trackOrder', value)` — the server (ConnectionHandler) and client pre-emit validation pick this up with ZERO server code changes.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/project/accept-list.test.ts`:

```ts
describe('trackOrder path', () => {
  it('the whole-array leaf is writable', () => {
    expect(pathIsWritable('trackOrder')).toBe(true);
  });
  it('per-element writes are NOT writable', () => {
    expect(pathIsWritable('trackOrder.0')).toBe(false);
  });
  it('a valid permutation passes validatePathAndValue', () => {
    expect(validatePathAndValue('trackOrder', identityTrackOrder())).toEqual({ ok: true });
  });
  it('duplicates are value.invalid', () => {
    const dupes = identityTrackOrder(); dupes[1] = 0;
    const r = validatePathAndValue('trackOrder', dupes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value.invalid');
  });
  it('wrong length is value.invalid', () => {
    const r = validatePathAndValue('trackOrder', identityTrackOrder().slice(1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value.invalid');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/src/project/accept-list.test.ts`
Expected: FAIL — `pathIsWritable('trackOrder')` is `false`.

- [ ] **Step 3: Implement**

In `PATTERNS`, right after `['bpm'],`:

```ts
  // Whole-array atomic write — the ONLY way to change display order (a
  // per-element pattern could produce a duplicated index mid-flight).
  ['trackOrder'],
```

In `resolveLeafSchema`, extend the top-level block:

```ts
  if (tokens.length === 1) {
    if (tokens[0] === 'bpm') return Schemas.Project.shape.bpm;
    if (tokens[0] === 'trackOrder') return Schemas.TrackOrder;
    return null;
  }
```

(`indicesInRange` needs no change: `tokens[0] !== 'tracks'` already returns `true`.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/shared/src/project/accept-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/accept-list.ts packages/shared/src/project/accept-list.test.ts
git commit -m "feat(shared): accept-list allows atomic trackOrder writes"
```

---

### Task 6: Client plumbing — dispatch policy, offline persistence, undo identity

**Files:**
- Modify: `packages/client/src/sync/dispatchPolicy.ts` (~line 6)
- Create: `packages/client/src/sync/dispatchPolicy.test.ts` (none exists)
- Modify: `packages/client/src/project/storage.ts` (`reconcileWithDefaults` ~line 85, `replaceProject` ~line 130)
- Modify: `packages/client/src/app/AppRuntime.ts` (undo `getLiveValue` wiring, ~line 50)
- Modify: `packages/client/src/app/synthContext.ts` (`dispatchLocal` priorValue, ~line 39)
- Modify: `packages/client/src/app/projectOps.ts` (comment only, at `enqueueWholeProjectDiff` ~line 183)
- Test: `packages/client/src/project/reconcile.test.ts`, `packages/client/src/project/storage.test.ts`

**Interfaces:**
- Consumes: `coerceTrackOrder` (Task 1), `Project.trackOrder` (Task 2).
- Produces: `gestureEndForLeaf('trackOrder') === true` (immediate wire flush; one undo entry per drag, no drag-merge); file open / `replaceProject` carry the order; undo/redo identity comparison works for the first non-primitive leaf.

**The undo identity problem (why AppRuntime/synthContext change):** every existing leaf is a primitive, so undoHistory's skip-if-superseded `getLiveValue(path) !== leaf.after` and dispatch-time `priorValue` capture rely on `===`. `trackOrder` is an array: reads from the reactive `project` return a Vue Proxy while the dispatched value is a raw array — identity never matches and undo would silently skip every reorder. Fix at the two boundaries with `toRaw` (Vue's reactive set-trap already stores raw values, so unwrapped reads are stable).

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/sync/dispatchPolicy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gestureEndForLeaf } from './dispatchPolicy';

describe('gestureEndForLeaf', () => {
  it('trackOrder is a discrete action (immediate flush, no undo drag-merge)', () => {
    expect(gestureEndForLeaf('trackOrder')).toBe(true);
  });
  it('continuous leaves stay continuous', () => {
    expect(gestureEndForLeaf('volume')).toBe(false);
  });
});
```

Append to `packages/client/src/project/reconcile.test.ts`:

```ts
it('missing trackOrder heals to identity', () => {
  const p = freshProject() as Record<string, unknown>;
  delete p.trackOrder;
  expect(reconcileWithDefaults(p).trackOrder).toEqual(identityTrackOrder());
});

it('an invalid trackOrder heals to identity', () => {
  const p = freshProject();
  p.trackOrder = [1, 2, 3];
  expect(reconcileWithDefaults(p).trackOrder).toEqual(identityTrackOrder());
});

it('a valid shuffled trackOrder survives', () => {
  const p = freshProject();
  p.trackOrder = [...p.trackOrder].reverse();
  expect(reconcileWithDefaults(p).trackOrder).toEqual(p.trackOrder);
});
```

Append to `packages/client/src/project/storage.test.ts` (in/next to the existing `replaceProject` coverage):

```ts
it('replaceProject copies trackOrder in place (array identity preserved)', () => {
  const target = freshProject();
  const before = target.trackOrder;
  const source = freshProject();
  source.trackOrder = [...source.trackOrder].reverse();
  replaceProject(target, source);
  expect(target.trackOrder).toEqual(source.trackOrder);
  expect(target.trackOrder).toBe(before); // same array object, contents replaced
});
```

(Import `identityTrackOrder` from `@fiddle/shared` where needed.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/client/src/sync/dispatchPolicy.test.ts packages/client/src/project/reconcile.test.ts packages/client/src/project/storage.test.ts`
Expected: the three new behaviors FAIL (`gestureEndForLeaf('trackOrder')` false; reconciled project lacks/keeps-bad `trackOrder`; `replaceProject` leaves target order unchanged).

- [ ] **Step 3: Implement**

`dispatchPolicy.ts` — add to `DISCRETE_LEAF_FIELDS`:

```ts
  'trackOrder', // whole-order atomic write per drop — discrete, flush immediately
```

`storage.ts` — import `coerceTrackOrder` from `@fiddle/shared`. In `reconcileWithDefaults`'s `out` object, after `bpm: coerceBpm(p.bpm),`:

```ts
    // Same permutation rule as the sync/server boundary (normalizeProject).
    trackOrder: coerceTrackOrder(p.trackOrder),
```

In `replaceProject`, after `target.bpm = source.bpm;`:

```ts
  // In-place splice keeps the reactive array's identity (same policy as the
  // nested Object.assigns below).
  target.trackOrder.splice(0, target.trackOrder.length, ...source.trackOrder);
```

`AppRuntime.ts` — add `toRaw` to the vue import (`import { toRaw, type InjectionKey } from 'vue';` — note the current import is type-only) and change the undo wiring:

```ts
  const history = createUndoHistory({
    // toRaw: undoHistory compares by identity (skip-if-superseded). Primitive
    // leaves are unaffected; object leaves (trackOrder) read back as reactive
    // proxies which would never === the raw dispatched value.
    getLiveValue: (path) => {
      const v = getDeep(project as unknown as Record<string, unknown>, path);
      return typeof v === 'object' && v !== null ? toRaw(v) : v;
    },
```

`synthContext.ts` — add `toRaw` to the vue import; in `dispatchLocal`:

```ts
  function dispatchLocal(path: Path, value: unknown): void {
    const gestureEnd = gestureEndForLeaf(String(path[path.length - 1]));
    const prior = getDeep(project as unknown as Record<string, unknown>, path);
    // toRaw: object leaves (trackOrder) must be captured raw so undo's
    // identity comparisons (see AppRuntime getLiveValue) hold.
    const priorValue = typeof prior === 'object' && prior !== null ? toRaw(prior) : prior;
    bus.dispatchLocal({ path, value, priorValue, gestureEnd });
  }
```

`projectOps.ts` — comment only, above the `enqueueWholeProjectDiff` function declaration:

```ts
  // NOTE: trackOrder is deliberately NOT diffed here. This fallback only runs
  // against servers without the bulk-load capability, which also predate the
  // trackOrder accept-list entry — they would nack the path (and a nack rolls
  // back local state). The bulk `load` message carries trackOrder wholesale.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/client/src/sync/dispatchPolicy.test.ts packages/client/src/project/reconcile.test.ts packages/client/src/project/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/dispatchPolicy.ts packages/client/src/sync/dispatchPolicy.test.ts packages/client/src/project/storage.ts packages/client/src/project/reconcile.test.ts packages/client/src/project/storage.test.ts packages/client/src/app/AppRuntime.ts packages/client/src/app/synthContext.ts packages/client/src/app/projectOps.ts
git commit -m "feat(client): trackOrder dispatch policy, offline persistence, undo identity for object leaves"
```

---

### Task 7: Ordered-entries helper + `addTrack` appends to the end

**Files:**
- Create: `packages/client/src/project/trackEntries.ts`
- Create: `packages/client/src/project/trackEntries.test.ts`
- Modify: `packages/client/src/app/synthContext.ts` (`addTrack`, ~line 167)
- Test: `packages/client/src/app/synthContext.test.ts` (the `variable track count` describe, ~line 864)

**Interfaces:**
- Consumes: `moveTrackBefore`, `ordersEqual` (Task 1); `dispatchLocal` (in-scope in synthContext).
- Produces: `orderedEnabledEntries(project): { track: ProjectTrack; index: number; displayPos: number }[]` — `index` is the POOL index (colors/sync/focus), `displayPos` is the 0-based position among enabled tracks (numbering). Consumed by Task 8 (StudioView, TrackMixer).

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/project/trackEntries.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { orderedEnabledEntries } from './trackEntries';

describe('orderedEnabledEntries', () => {
  it('identity order: enabled slots in pool order with sequential displayPos', () => {
    const p = freshProject(); // 4 enabled by default
    const entries = orderedEnabledEntries(p);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(entries.map((e) => e.displayPos)).toEqual([0, 1, 2, 3]);
  });
  it('follows trackOrder and skips disabled slots', () => {
    const p = freshProject();
    p.trackOrder = [2, 5, 0, ...p.trackOrder.filter((i) => ![2, 5, 0].includes(i))];
    const entries = orderedEnabledEntries(p); // slot 5 is disabled by default
    expect(entries.map((e) => e.index)).toEqual([2, 0, 1, 3]);
    expect(entries.map((e) => e.displayPos)).toEqual([0, 1, 2, 3]);
    expect(entries[0].track).toBe(p.tracks[2]);
  });
});
```

Append to the `variable track count` describe in `packages/client/src/app/synthContext.test.ts` (reuse the file's existing runtime/ctx setup helper — see how its sibling tests construct `createAppRuntime` + `createSynthContext`):

```ts
it('addTrack appends the reused slot to the end of trackOrder', () => {
  // Free a middle slot, then re-add: the slot re-enables (lowest free index)
  // but must DISPLAY last (spec: new tracks always appear at the end).
  ctx.removeTrack(1);
  ctx.addTrack();
  const { project } = runtime.store;
  expect(project.tracks[1].enabled).toBe(true);
  const enabledInOrder = project.trackOrder.filter((i) => project.tracks[i].enabled);
  expect(enabledInOrder[enabledInOrder.length - 1]).toBe(1);
});

it('addTrack on a fresh project shows the new slot last', () => {
  // Enabling slot 4 moves it past the disabled 5..31 in the raw order array
  // (display-equivalent — the invariant is the ENABLED projection, not the
  // raw array).
  ctx.addTrack();
  const { project } = runtime.store;
  const enabledInOrder = project.trackOrder.filter((i) => project.tracks[i].enabled);
  expect(enabledInOrder).toEqual([0, 1, 2, 3, 4]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/client/src/project/trackEntries.test.ts packages/client/src/app/synthContext.test.ts`
Expected: trackEntries FAILS (module missing); the new synthContext test FAILS (order untouched by addTrack).

- [ ] **Step 3: Implement**

Create `packages/client/src/project/trackEntries.ts`:

```ts
import type { Project, ProjectTrack } from './types';

export interface TrackEntry {
  track: ProjectTrack;
  /** Pool index — track IDENTITY (colors, sync paths, focus, selection). */
  index: number;
  /** 0-based position among ENABLED tracks in display order — used ONLY for
   *  presentation (the `Track ${n+1}` fallback numbering). */
  displayPos: number;
}

// Enabled slots in display order. The single definition of "the track list
// the user sees" — StudioView's overview grid and TrackMixer both consume it.
export function orderedEnabledEntries(
  project: Pick<Project, 'tracks' | 'trackOrder'>,
): TrackEntry[] {
  const entries: TrackEntry[] = [];
  for (const index of project.trackOrder) {
    const track = project.tracks[index];
    if (track?.enabled) entries.push({ track, index, displayPos: entries.length });
  }
  return entries;
}
```

Export it from `packages/client/src/project/index.ts` (match the file's existing export style):

```ts
export { orderedEnabledEntries, type TrackEntry } from './trackEntries';
```

In `synthContext.ts`, import `moveTrackBefore, ordersEqual` from `@fiddle/shared` and replace `addTrack`:

```ts
  // Add a track = enable the lowest-index disabled slot (fills a freed hole if
  // any) AND move that slot to the end of the display order (new tracks always
  // appear last — spec 2026-07-15-track-reorder-design). Both dispatches share
  // one synchronous task, so the undo burst rule makes them ONE undo entry.
  const addTrack = (): void => {
    const idx = project.tracks.findIndex(t => !t.enabled);
    if (idx === -1) return;
    dispatchLocal(['tracks', idx, 'enabled'], true);
    const next = moveTrackBefore(project.trackOrder, idx, null);
    if (!ordersEqual(next, project.trackOrder)) dispatchLocal(['trackOrder'], next);
  };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/client/src/project/trackEntries.test.ts packages/client/src/app/synthContext.test.ts`
Expected: PASS (all, including the pre-existing synthContext suites).

- [ ] **Step 5: Add the undo-integrity test (guards the Task 6 toRaw fix end-to-end)**

Append to `synthContext.test.ts` (same setup helper):

```ts
it('a trackOrder dispatch is undoable (object-leaf identity)', async () => {
  const { project } = runtime.store;
  const before = [...project.trackOrder];
  const next = [...project.trackOrder].reverse();
  ctx.dispatchLocal(['trackOrder'], next);
  expect(project.trackOrder).toEqual(next);
  await Promise.resolve(); // let the undo burst seal (microtask)
  runtime.history.undo();
  expect([...project.trackOrder]).toEqual(before);
});
```

Run: `npx vitest run packages/client/src/app/synthContext.test.ts`
Expected: PASS. If the undo assertion fails, the Task 6 `toRaw` wiring is wrong — fix THERE, do not adjust the test.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/project/trackEntries.ts packages/client/src/project/trackEntries.test.ts packages/client/src/project/index.ts packages/client/src/app/synthContext.ts packages/client/src/app/synthContext.test.ts
git commit -m "feat(client): ordered enabled-track entries helper; addTrack appends to display order"
```

---

### Task 8: StudioView + TrackMixer render through the order; positional numbering

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (`enabledTrackEntries` ~line 407; template title ~line 51; focused-view names ~lines 90, 183; remove dialog ~line 477)
- Modify: `packages/client/src/components/TrackMixer.vue` (`enabledChannels` ~line 104; strip label ~line 31)

No unit tests (both are `.vue` — repo convention forbids mounting; the ordering logic itself was tested in Task 7). Verify by typecheck + the Task 10/11 gates.

- [ ] **Step 1: StudioView — order-aware entries**

Import `orderedEnabledEntries` from `../project` and replace the `enabledTrackEntries` computed:

```ts
// Enabled slots in display order (trackOrder indirection). entry.index is the
// TRUE pool index (color, sync paths, focused view); entry.displayPos numbers
// the visible list for the `Track ${n+1}` fallback.
const enabledTrackEntries = computed(() => orderedEnabledEntries(project));
```

- [ ] **Step 2: StudioView — positional numbering everywhere the user sees a default name**

Add below `enabledTrackEntries`:

```ts
// Display position lookup for name fallbacks outside the v-for (focused
// header, remove dialog). Falls back to the pool index if the slot is not
// in the enabled list (cannot happen for a rendered track; belt-and-braces).
const displayPosByPool = computed(() => {
  const m = new Map<number, number>();
  for (const e of enabledTrackEntries.value) m.set(e.index, e.displayPos);
  return m;
});
const displayPosOf = (poolIndex: number): number =>
  displayPosByPool.value.get(poolIndex) ?? poolIndex;
```

Template edits (three call sites + dialog):
- Line ~51: `:title="trackDisplayName(entry.track, entry.index)"` → `:title="trackDisplayName(entry.track, entry.displayPos)"`
- Line ~90: `:displayName="trackDisplayName(focusedTrack!, activeTrackIndex)"` → `:displayName="trackDisplayName(focusedTrack!, displayPosOf(activeTrackIndex!))"`
- Line ~183: same replacement as line 90.
- Line ~477 (script): `trackDisplayName(project.tracks[index], index)` → `trackDisplayName(project.tracks[index], displayPosOf(index))`

- [ ] **Step 3: TrackMixer — same order, same numbering**

(Component is intentionally retained but unmounted — keep it consistent so a future re-mount doesn't fork the order rule.) Replace `enabledChannels`:

```ts
// Display order comes from the shared trackOrder indirection — same rule as
// StudioView's overview grid (see project/trackEntries.ts).
const enabledChannels = computed(() =>
  synthCtx.project.trackOrder
    .map((index) => ({ track: props.trackStates[index], index }))
    .filter((c) => c.track?.enabled)
    .map((c, displayPos) => ({ ...c, displayPos })),
);
```

Template line ~31: `trackDisplayName(chan.track, chan.index)` → `trackDisplayName(chan.track, chan.displayPos)`.

(`synthCtx` is already injected at the top of the file. `props.trackStates` is the full 32-slot pool array, indexable by pool index.)

- [ ] **Step 4: Typecheck + full client tests**

Run: `npm run typecheck && npx vitest run packages/client`
Expected: green (no behavior change with the identity order).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/views/StudioView.vue packages/client/src/components/TrackMixer.vue
git commit -m "feat(client): overview grid and mixer render tracks through trackOrder; positional numbering"
```

---

### Task 9: Drag & drop in the overview grid

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (template `.track-cell` ~line 43; script additions near the other track handlers; scoped CSS near `.tracks-grid` ~line 777)

Interaction contract (spec §2): drag arms ONLY from the card header (`.tracker-header-bar` inside Tracker) so knobs/steps/toolbar never start a drag; insertion indicator before/after the hovered card by pointer X (the grid flows row-wise); drop dispatches ONE `dispatchLocal(['trackOrder'], next)`; self-drop / no-op drops dispatch nothing; Escape or dropping outside cancels (dragend fires, no dispatch). No Tracker.vue changes — arming inspects `event.target.closest()` from the cell.

- [ ] **Step 1: Template — make cells drag sources and drop targets**

Replace the `.track-cell` opening tag (keep the `<Tracker …/>` child untouched):

```html
        <div
          v-for="entry in enabledTrackEntries"
          :key="entry.index"
          class="track-cell"
          :class="{
            'drag-source': draggingPool === entry.index,
            'drop-before': dropTarget?.pool === entry.index && dropTarget.before,
            'drop-after': dropTarget?.pool === entry.index && !dropTarget.before,
          }"
          :draggable="armedPool === entry.index"
          @pointerdown="armDrag($event, entry.index)"
          @dragstart="onDragStart($event, entry.index)"
          @dragover="onDragOver($event, entry.index)"
          @dragleave="onDragLeave(entry.index)"
          @drop="onDrop($event, entry.index)"
          @dragend="onDragEnd"
        >
```

- [ ] **Step 2: Script — drag state + handlers**

Add near the other track functions (imports: add `moveTrackBefore, ordersEqual` to the existing `@fiddle/shared` import):

```ts
// --- Drag & drop track reordering (overview grid only; spec §2) ---
// Armed from the card header so inner controls never start a drag. A drop
// emits ONE atomic trackOrder op ("move dragged pool id before anchor pool
// id"), computed against the CURRENT order at drop time — resilient to a
// peer's concurrent reorder; LWW settles simultaneous drags.
const armedPool = ref<number | null>(null);     // header pressed — draggable
const draggingPool = ref<number | null>(null);  // drag in flight
const dropTarget = ref<{ pool: number; before: boolean } | null>(null);

function armDrag(e: PointerEvent, pool: number): void {
  const el = e.target as HTMLElement | null;
  armedPool.value = el?.closest('.tracker-header-bar') ? pool : null;
}
function onDragStart(e: DragEvent, pool: number): void {
  if (armedPool.value !== pool) { e.preventDefault(); return; }
  draggingPool.value = pool;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(pool));
  }
}
function onDragOver(e: DragEvent, pool: number): void {
  if (draggingPool.value === null || draggingPool.value === pool) return;
  e.preventDefault(); // required — without it the browser refuses the drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value = { pool, before: e.clientX < rect.left + rect.width / 2 };
}
function onDragLeave(pool: number): void {
  if (dropTarget.value?.pool === pool) dropTarget.value = null;
}
function onDrop(e: DragEvent, pool: number): void {
  e.preventDefault();
  const moved = draggingPool.value;
  const target = dropTarget.value;
  if (moved === null || target === null || target.pool !== pool) return;
  // "after card X" = "before the enabled card that follows X" (null = end).
  const entries = enabledTrackEntries.value;
  const ti = entries.findIndex((en) => en.index === target.pool);
  const anchor = target.before ? target.pool : (entries[ti + 1]?.index ?? null);
  const next = moveTrackBefore(project.trackOrder, moved, anchor);
  if (!ordersEqual(next, project.trackOrder)) dispatchLocal(['trackOrder'], next);
}
function onDragEnd(): void {
  // Fires on drop, cancel (Escape), and drop-outside alike — single cleanup.
  armedPool.value = null;
  draggingPool.value = null;
  dropTarget.value = null;
}
```

(Adjacent no-op drops resolve to `moveTrackBefore(order, moved, moved)` or an unchanged permutation — `ordersEqual` skips the dispatch, so no op and no undo entry.)

- [ ] **Step 3: Scoped CSS** (append near the existing `.tracks-grid` rules)

```css
.track-cell { position: relative; }
.track-cell.drag-source { opacity: 0.45; }
.track-cell.drop-before::before,
.track-cell.drop-after::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #00f0ff;
  border-radius: 2px;
  pointer-events: none;
}
.track-cell.drop-before::before { left: -6px; }
.track-cell.drop-after::after { right: -6px; }
/* Grab affordance on the drag handle (child component ⇒ :deep). */
.tracks-grid :deep(.tracker-header-bar) { cursor: grab; }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(client): drag-and-drop track reordering in the overview grid"
```

---

### Task 10: Full gate

- [ ] **Step 1: Run the merge gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. Fix anything red before proceeding (and re-run the full gate after any fix).

- [ ] **Step 2: Commit any stragglers** (only if fixes were needed; keep them scoped)

---

### Task 11: Browser verification (MANDATORY before reporting done)

Use the Playwright MCP against the LOCAL dev stack.

- [ ] **Step 1: Ensure `npm run dev:obs` is running** (LOCAL Docker DB — NEVER `npm run dev`). If port 5173 is already taken, the user's instance is running — REUSE it, never kill it.
- [ ] **Step 2: Open the app, create/join a session, confirm 4 tracks render.** Check the console is clean.
- [ ] **Step 3: Drag Track 1's header to after Track 3.** Verify: card order changes; unnamed tracks renumber Track 1..4 top-to-bottom; each card KEEPS its color (color follows the track, not the position); console clean. Verify inner controls: dragging from a knob/step does NOT start a drag; a plain click on the header still focuses the track.
- [ ] **Step 4: Reload the page.** The order must survive (server snapshot round-trip — exercises Task 4).
- [ ] **Step 5: Undo (Cmd+Z).** The order must revert to pre-drag (exercises Task 6's toRaw fix in the real app).
- [ ] **Step 6: Two-tab sync:** open the same session in a second tab, drag in tab 1, confirm tab 2 reorders live; then drag in tab 2 and confirm tab 1 follows.
- [ ] **Step 7: Add/remove:** remove a middle track, add a track — the re-enabled slot must appear LAST in the list.
- [ ] **Step 8: Drag during playback** — press play, reorder, audio must continue unaffected.
- [ ] **Step 9: Report observations to the user, then CLOSE every tab/browser session you opened** (and stop any dev server YOU started — not the user's).

---

## Deployment note (for the eventual merge — do not merge without user instruction)

Client (Vercel) and server (Render) deploy from the same merge. Brief skew is safe in both directions: an old server nacks `set ['trackOrder']` (`path.invalid`) and the client rolls back locally; an old client's bulk `load` (no `trackOrder`) passes the optional schema and normalizes to identity on the new server.
