# Sparse Persisted Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the per-flush DB write from ~224 KB to ~28 KB (≈8×) losslessly by persisting only pool slots that carry information, changing only the DB-persisted form.

**Architecture:** A pure codec in `@fiddle/shared` packs a full `Project` into a sparse stored form (only `enabled` slots, or slots differing from the deterministic `freshTrack(false)` default) and unpacks it back to a full 32-slot `Project` (handling both the new sparse object form and the legacy 32-element array via an `Array.isArray` discriminator — no data migration). `PostgresSessionStore` calls `packProject` on write and `unpackProject` on read; everything else (in-memory store, wire snapshot, op paths) is untouched.

**Tech Stack:** TypeScript, npm workspaces (`@fiddle/shared`, `@fiddle/server`), Vitest, porsager/postgres v3.

**Branch:** Work on `feat/sparse-snapshot` (already created off `main`; the design spec is committed there at `docs/superpowers/specs/2026-06-06-sparse-snapshot-design.md`). Do not work on `main`.

**Reference:** Read the spec `docs/superpowers/specs/2026-06-06-sparse-snapshot-design.md` before starting.

---

## File Structure

- **Create** `packages/shared/src/project/snapshot-codec.ts` — the whole codec: `deepEqual` helper, `StoredProject` type, `packProject`, `unpackProject`. One responsibility: translate between the full in-memory `Project` and the sparse stored form.
- **Create** `packages/shared/src/project/snapshot-codec.test.ts` — unit tests (the primary correctness oracle; always run, no DB).
- **Modify** `packages/shared/src/project/index.ts` — export the new codec symbols.
- **Modify** `packages/server/src/session/PostgresSessionStore.ts` — pack on write (`create`, `saveSnapshot`), unpack on read (`getSnapshot`).
- **Modify** `packages/server/src/session/PostgresSessionStore.test.ts` — add integration assertions (gated on `TEST_DATABASE_URL`, skipped by default).

Existing symbols this plan relies on (verified):
- `freshTrack(enabled = true): ProjectTrack`, `freshProject(): Project` — `packages/shared/src/project/factory.ts`
- `normalizeProject(project: Project): Project` — `packages/shared/src/project/normalize.ts`
- `TRACK_POOL_SIZE = 32`, `DEFAULT_ENABLED_TRACKS = 4` — `packages/shared/src/project/constants.ts`
- `Project` (`{ schemaVersion: 2; bpm: number; tracks: ProjectTrack[] }`), `ProjectTrack` (`{ …; enabled: boolean }`) — `packages/shared/src/project/types.ts`
- The `this.sql.json(x as unknown as JsonArg)` cast pattern — `packages/shared`-aware `PostgresSessionStore.ts`

---

## Task 1: `deepEqual` structural helper

**Files:**
- Create: `packages/shared/src/project/snapshot-codec.ts`
- Test: `packages/shared/src/project/snapshot-codec.test.ts`

Why key-order-insensitive (not `JSON.stringify`): a track loaded from a legacy DB row keeps the stored key order, which may differ from a freshly built `freshTrack(false)`. A structural compare avoids false "differs" verdicts that would bloat migrated rows.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/project/snapshot-codec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deepEqual } from './snapshot-codec.js';

describe('deepEqual', () => {
  it('is true for identical primitives and structurally equal objects', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual({ x: 1, y: [2, 3] }, { x: 1, y: [2, 3] })).toBe(true);
  });

  it('is insensitive to key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('is false for differing values, lengths, or key sets', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
    expect(deepEqual({ a: 1 }, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: FAIL — cannot resolve `./snapshot-codec.js` (module/`deepEqual` not defined).

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/project/snapshot-codec.ts` (Tasks 2–3 add their own imports as they need them):

```ts
// Structural, key-order-insensitive deep equality. Used only to decide whether
// a disabled slot is still the pristine freshTrack(false) default (and so can be
// omitted from the stored snapshot). JSON.stringify is unsafe here because a
// legacy-loaded track may carry a different key order than a freshly built one.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/snapshot-codec.ts packages/shared/src/project/snapshot-codec.test.ts
git commit -m "feat(shared): structural deepEqual for snapshot codec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `packProject` (full → sparse)

**Files:**
- Modify: `packages/shared/src/project/snapshot-codec.ts`
- Test: `packages/shared/src/project/snapshot-codec.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/project/snapshot-codec.test.ts`:

```ts
import { packProject } from './snapshot-codec.js';
import { freshProject, freshTrack } from './factory.js';

describe('packProject', () => {
  it('keeps only the enabled slots for a default project', () => {
    const packed = packProject(freshProject()); // 4 enabled, 28 pristine padding
    expect(Object.keys(packed.tracks).sort()).toEqual(['0', '1', '2', '3']);
    expect(packed.bpm).toBe(120);
    expect(packed.schemaVersion).toBe(2);
  });

  it('keeps a disabled-but-edited slot (differs from fresh)', () => {
    const p = freshProject();
    p.tracks[10] = freshTrack(false);     // disabled padding...
    p.tracks[10].steps[0].note = 'C';     // ...but edited -> carries information
    const packed = packProject(p);
    expect(Object.keys(packed.tracks)).toContain('10');
  });

  it('keeps all slots when all are enabled', () => {
    const p = freshProject();
    p.tracks.forEach((t) => { t.enabled = true; });
    expect(Object.keys(packProject(p).tracks)).toHaveLength(32);
  });

  it('keeps an enabled-but-pristine slot (enabled wins)', () => {
    const p = freshProject();
    p.tracks[7] = freshTrack(true); // enabled, otherwise identical to fresh
    expect(Object.keys(packProject(p).tracks)).toContain('7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: FAIL — `packProject` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add these imports at the **top** of `packages/shared/src/project/snapshot-codec.ts`:

```ts
import type { Project, ProjectTrack } from './types.js';
import { freshTrack } from './factory.js';
```

Then append to the same file:

```ts
// The sparse form persisted to the DB. `tracks` is keyed by stringified pool
// index ("0".."31") and contains ONLY slots that carry information. Top-level
// schemaVersion + bpm are carried through unchanged.
export interface StoredProject {
  schemaVersion: Project['schemaVersion'];
  bpm: number;
  tracks: Record<string, ProjectTrack>;
}

// The one pristine-disabled template; a slot equal to this carries no
// information and is omitted from the stored form. Built once (read-only).
const PRISTINE_DISABLED: ProjectTrack = freshTrack(false);

// Full Project -> sparse StoredProject. A slot is kept iff it is enabled OR it
// differs from the pristine freshTrack(false) default (lossless for
// disabled-but-edited tracks; drops only untouched padding).
export function packProject(project: Project): StoredProject {
  const tracks: Record<string, ProjectTrack> = {};
  project.tracks.forEach((track, i) => {
    if (track.enabled || !deepEqual(track, PRISTINE_DISABLED)) {
      tracks[String(i)] = track;
    }
  });
  return { schemaVersion: project.schemaVersion, bpm: project.bpm, tracks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/snapshot-codec.ts packages/shared/src/project/snapshot-codec.test.ts
git commit -m "feat(shared): packProject — sparse snapshot encoder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `unpackProject` (sparse OR legacy → full) + round-trip + exports

**Files:**
- Modify: `packages/shared/src/project/snapshot-codec.ts`
- Modify: `packages/shared/src/project/index.ts`
- Test: `packages/shared/src/project/snapshot-codec.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/project/snapshot-codec.test.ts`:

```ts
import { unpackProject } from './snapshot-codec.js';
import { normalizeProject } from './normalize.js';

describe('unpackProject', () => {
  it('round-trips a default project (unpack(pack(p)) == normalizeProject(p))', () => {
    const p = freshProject();
    expect(unpackProject(packProject(p))).toEqual(normalizeProject(p));
  });

  it('round-trips a disabled-but-edited slot losslessly', () => {
    const p = freshProject();
    p.tracks[10] = freshTrack(false);
    p.tracks[10].steps[0].note = 'C';
    const out = unpackProject(packProject(p));
    expect(out.tracks[10].steps[0].note).toBe('C');
    expect(out.tracks[10].enabled).toBe(false);
  });

  it('reads the legacy full-array form unchanged', () => {
    const legacy = freshProject(); // tracks is a 32-element ARRAY
    legacy.tracks[0].steps[3].note = 'E';
    const out = unpackProject(legacy);
    expect(out.tracks).toHaveLength(32);
    expect(out.tracks[0].steps[3].note).toBe('E');
  });

  it('fills omitted indices with disabled fresh tracks', () => {
    const out = unpackProject(packProject(freshProject()));
    expect(out.tracks).toHaveLength(32);
    expect(out.tracks[20].enabled).toBe(false); // a padding slot
  });

  it('heals garbage defensively without throwing', () => {
    for (const bad of [null, undefined, 'nope', 42, {}, { tracks: 5 }]) {
      const out = unpackProject(bad);
      expect(out.tracks).toHaveLength(32);
      expect(out.tracks.some((t) => t.enabled)).toBe(true); // normalizeProject re-enables
      expect(out.schemaVersion).toBe(2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: FAIL — `unpackProject` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add these imports at the **top** of `packages/shared/src/project/snapshot-codec.ts`:

```ts
import { TRACK_POOL_SIZE } from './constants.js';
import { normalizeProject } from './normalize.js';
```

Then append to the same file:

```ts
// Sparse StoredProject OR legacy full-array Project -> full 32-slot Project.
// Discriminator: `tracks` as an array => legacy full form; as an object => sparse
// (build 32 slots, filling absent indices with disabled fresh tracks). Defensive:
// anything unrecognized falls through to be healed by normalizeProject; never
// throws. Structure only — invariant repair stays with normalizeProject.
export function unpackProject(stored: unknown): Project {
  const s = (stored && typeof stored === 'object')
    ? (stored as { schemaVersion?: unknown; bpm?: unknown; tracks?: unknown })
    : {};

  let tracks: ProjectTrack[];
  if (Array.isArray(s.tracks)) {
    tracks = s.tracks as ProjectTrack[]; // legacy full form
  } else if (s.tracks && typeof s.tracks === 'object') {
    const map = s.tracks as Record<string, ProjectTrack>;
    tracks = Array.from({ length: TRACK_POOL_SIZE }, (_, i) =>
      map[String(i)] ?? freshTrack(false),
    );
  } else {
    tracks = []; // normalizeProject will pad to TRACK_POOL_SIZE
  }

  return normalizeProject({
    schemaVersion: s.schemaVersion,
    bpm: s.bpm,
    tracks,
  } as Project);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/project/snapshot-codec.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Export the codec from the shared project barrel**

Edit `packages/shared/src/project/index.ts` — add after the `normalizeProject, coerceBpm` export line:

```ts
export { packProject, unpackProject, deepEqual } from './snapshot-codec.js';
export type { StoredProject } from './snapshot-codec.js';
```

Then verify the package re-exports cleanly:

Run: `npm run typecheck`
Expected: exit 0 (server + shared typecheck pass).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/project/snapshot-codec.ts packages/shared/src/project/snapshot-codec.test.ts packages/shared/src/project/index.ts
git commit -m "feat(shared): unpackProject + export sparse snapshot codec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire `PostgresSessionStore` to the codec

**Files:**
- Modify: `packages/server/src/session/PostgresSessionStore.ts`
- Test: `packages/server/src/session/PostgresSessionStore.test.ts`

Note: the store tests are integration tests gated on `TEST_DATABASE_URL` (skipped in the default run). The codec's correctness is already covered by Task 1–3 unit tests; these additions verify the wire-up and that the stored column is actually sparse.

- [ ] **Step 1: Write the failing test**

In `packages/server/src/session/PostgresSessionStore.test.ts`, update the import on line 3 to pull the codec symbol:

```ts
import { freshProject, DEFAULT_SESSION_SETTINGS, unpackProject } from '@fiddle/shared';
```

Then add these tests inside the `maybe('PostgresSessionStore (integration)', …)` block (e.g. after the existing `getSnapshot … upserts` test):

```ts
  it('stores the snapshot in sparse form (tracks is a keyed object, not a 32-array)', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: '',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const [{ project }] = await sql<{ project: { tracks: unknown } }[]>`
      select project from session_snapshots where session_id = 's1'
    `;
    expect(Array.isArray(project.tracks)).toBe(false);     // sparse, not full array
    expect(Object.keys(project.tracks as object)).toHaveLength(4); // 4 enabled
  });

  it('getSnapshot rehydrates the full 32-slot project from sparse storage', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: '',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const got = await store.getSnapshot('s1');
    expect(got?.tracks).toHaveLength(32);
    expect(got?.tracks.filter((t) => t.enabled)).toHaveLength(4);
  });

  it('reads a legacy full-array row written before the codec', async () => {
    await store.create({
      id: 's1', name: 'Jam', description: '',
      ownerUserId: null, ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    // Simulate a pre-codec row: overwrite the column with the full array form.
    const legacy = freshProject();
    legacy.tracks[0].steps[2].note = 'G';
    await sql`update session_snapshots set project = ${sql.json(legacy as never)} where session_id = 's1'`;
    const got = await store.getSnapshot('s1');
    expect(got?.tracks).toHaveLength(32);
    expect(got?.tracks[0].steps[2].note).toBe('G');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=<throwaway-pg-url> npx vitest run packages/server/src/session/PostgresSessionStore.test.ts`
Expected: FAIL — `stores the snapshot in sparse form` fails because `tracks` is still written as a 32-element array.

(If no throwaway Postgres is available, this suite stays skipped; rely on the Task 1–3 unit tests for correctness and proceed — note in the commit that the integration assertions were not executed.)

- [ ] **Step 3: Write minimal implementation**

Edit `packages/server/src/session/PostgresSessionStore.ts`:

1. Update the imports at the top:

```ts
import postgres from 'postgres';
import type { Project } from '@fiddle/shared';
import { packProject, unpackProject } from '@fiddle/shared';
```

2. In `create`, change the snapshot insert to pack the project:

```ts
    await this.sql`
      insert into session_snapshots (session_id, project)
      values (${input.id}, ${this.sql.json(packProject(input.project) as unknown as JsonArg)})
    `;
```

3. Replace `getSnapshot` to unpack (note the row type changes to `unknown`):

```ts
  async getSnapshot(id: string): Promise<Project | null> {
    const rows = await this.sql<{ project: unknown }[]>`
      select project from session_snapshots where session_id = ${id} limit 1
    `;
    return rows[0] ? unpackProject(rows[0].project) : null;
  }
```

4. In `saveSnapshot`, pack the project in both the `select` and the `do update`:

```ts
  async saveSnapshot(id: string, project: Project): Promise<void> {
    const stored = packProject(project);
    await this.sql`
      insert into session_snapshots (session_id, project, updated_at)
      select ${id}, ${this.sql.json(stored as unknown as JsonArg)}, now()
      where exists (select 1 from sessions where id = ${id})
      on conflict (session_id) do update
        set project = excluded.project, updated_at = now()
    `;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=<throwaway-pg-url> npx vitest run packages/server/src/session/PostgresSessionStore.test.ts`
Expected: PASS (all integration tests, including the 3 new ones).

Also run the default (DB-less) server suite to confirm nothing else broke:

Run: `npm test`
Expected: server 113 passed / 8 skipped (the Postgres suite skips without `TEST_DATABASE_URL`), shared green (now includes the new codec tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/session/PostgresSessionStore.ts packages/server/src/session/PostgresSessionStore.test.ts
git commit -m "feat(server): persist session snapshots in sparse form

saveSnapshot/create pack the project to the sparse stored form; getSnapshot
unpacks (handling legacy full-array rows). ~8x less write IO per flush.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full gate + manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck exit 0; client 291 / server 113+8 skipped / shared green (codec tests added); build emits `dist/index.js`.

- [ ] **Step 2: Manual browser verification (dev path)**

1. Start dev (`npm run dev` per AGENTS.md) with a working `DATABASE_URL`.
2. Create a session, edit a few steps across 2–3 tracks, add a 5th track, then remove it (disabling it) after editing one of its steps.
3. Reload the page / rejoin the session. Expected: enabled tracks and their edits are intact; re-adding the removed track restores its edited step (lossless).
4. Optional (with DB access): `select project from session_snapshots where session_id = '<id>'` — confirm `tracks` is a keyed object (e.g. `"0".."4"`), not a 32-element array.
5. Close the Playwright browser when done (per AGENTS.md).

- [ ] **Step 3: Stop — hand back for sign-off**

Do not merge or push. Keep the `feat/sparse-snapshot` branch for the user's own browser verification and sign-off (per project rules: browser verification by the agent does not replace the user's sign-off; no merge/push without explicit instruction).

---

## Notes for the implementer

- **Idempotent fast path:** `normalizeProject` returns its input by reference when already valid, so `unpackProject` is cheap on the hot read path.
- **Why InMemorySessionStore is untouched:** it holds the full `Project` in a `Map` (RAM); the codec is a DB-serialization concern. Keeping it full preserves existing in-memory test expectations and isolates the codec logic in shared.
- **No schemaVersion bump:** the `Array.isArray(tracks)` discriminator distinguishes legacy from sparse, so existing rows read correctly and self-migrate on next flush. `schemaVersion` stays `2`.
- **Capacity vs IO:** this reduces write **IO** per flush, not stored **capacity** (the 6.91 GB dashboard figure is reserved system overhead, unrelated).
