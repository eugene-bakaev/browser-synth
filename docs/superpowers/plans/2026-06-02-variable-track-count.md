# Variable Track Count (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a session have a variable number of tracks (add/remove), backed by a fixed 32-slot pool with a per-slot `enabled` flag synced as an ordinary last-write-wins boolean — tracks stay fully shared (no ownership yet).

**Architecture:** `Project.tracks` becomes a fixed-length-32 array; each `ProjectTrack` carries `enabled: boolean`. "Add" enables the lowest-index disabled slot; "remove" disables a specific slot (data retained). No structural sync ops, no index shifting. Legacy 4-track projects are padded to 32 slots at every deserialize boundary (client load/open/snapshot, server snapshot load) by a shared, idempotent normalizer. The change is additive — **no `schemaVersion` bump**.

**Tech Stack:** TypeScript (strict), Vue 3 reactivity, Zod (wire schema), Vitest. npm workspaces: `@fiddle/shared`, `@fiddle/client`, `@fiddle/server`.

**Design spec:** `docs/superpowers/specs/2026-06-02-variable-track-count-design.md`

---

## Conventions for every task

- Run commands from the **repo root**. Test a single workspace with `npm test -w @fiddle/shared` (or `-w @fiddle/client` / `-w @fiddle/server`). A single file: `npm test -w @fiddle/shared -- src/project/normalize.test.ts`.
- Commit only the files the task touched — **never** `git add -A`. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Branch is already `feat/variable-track-count` (off `main`). Do **not** merge.
- `strict` + `noUnusedLocals`/`noUnusedParameters` are on. `exactOptionalPropertyTypes` is off.

## File structure (what changes and why)

**`@fiddle/shared`**
- `src/project/factory.ts` — adds `TRACK_POOL_SIZE`, `DEFAULT_ENABLED_TRACKS`; `freshTrack(enabled)`; `freshProject()` → 32 slots.
- `src/project/types.ts` — `ProjectTrack.enabled`; `Project.tracks: ProjectTrack[]`.
- `src/project/schema.ts` — `TrackSchema.enabled`; `ProjectSchema.tracks` length 32.
- `src/project/accept-list.ts` — `enabled` writable path + leaf schema; bound 4→`TRACK_POOL_SIZE`.
- `src/project/normalize.ts` (**new**) — `normalizeTrackPool(project)`: idempotent pad-to-32 + default `enabled`.
- `src/project/index.ts` — re-export the new constants + normalizer.

**`@fiddle/client`**
- `src/project/storage.ts` — `reconcileWithDefaults` pads to 32 + defaults `enabled`; `replaceProject` loops 32 + copies `enabled`.
- `src/sync/messageDispatch.ts` — normalize `snapshot.project` before `replaceProject`.
- `src/composables/useSynth.ts` — init/tick loops 4→32; `enabled` watcher (audio gate + sync emit); `addTrack`/`removeTrack`/`enabledTrackCount` exposed.
- `src/sync/synthContext.ts` — expose the three new members on the context type (verify exact shape during the task).
- `src/ui/trackColors.ts` (**new**) — `trackColor(index)` helper.
- `src/views/StudioView.vue` — render enabled slots only; add/remove controls; use `trackColor`.
- `src/components/TrackMixer.vue` — render enabled slots only (true index preserved); use `trackColor`.

**`@fiddle/server`**
- `src/sync/ConnectionHandler.ts` — normalize the loaded session project before seeding the room.

---

### Task 1: Shared — pool constants, `enabled` field, factory

**Files:**
- Modify: `packages/shared/src/project/factory.ts`
- Modify: `packages/shared/src/project/types.ts`
- Modify: `packages/shared/src/project/index.ts`
- Test: `packages/shared/src/project/factory.test.ts` (**new**)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/project/factory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { freshProject, freshTrack, TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './factory.js';

describe('freshProject track pool', () => {
  it('returns exactly TRACK_POOL_SIZE slots', () => {
    expect(freshProject().tracks).toHaveLength(TRACK_POOL_SIZE);
  });

  it('enables exactly the first DEFAULT_ENABLED_TRACKS slots', () => {
    const enabled = freshProject().tracks.map(t => t.enabled);
    const expected = Array.from({ length: TRACK_POOL_SIZE }, (_, i) => i < DEFAULT_ENABLED_TRACKS);
    expect(enabled).toEqual(expected);
  });

  it('TRACK_POOL_SIZE is 32 and DEFAULT_ENABLED_TRACKS is 4', () => {
    expect(TRACK_POOL_SIZE).toBe(32);
    expect(DEFAULT_ENABLED_TRACKS).toBe(4);
  });

  it('freshTrack(false) is disabled, freshTrack() defaults to enabled', () => {
    expect(freshTrack(false).enabled).toBe(false);
    expect(freshTrack().enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- src/project/factory.test.ts`
Expected: FAIL — `TRACK_POOL_SIZE`/`DEFAULT_ENABLED_TRACKS` not exported, `enabled` missing.

- [ ] **Step 3: Add the `enabled` field to the type**

In `packages/shared/src/project/types.ts`, add `enabled` to `ProjectTrack` and widen `tracks`:

```ts
export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;
  mixer: MixerState;
  // `steps` is always a fixed 64-element buffer. `patternLength` (1..64) is the
  // play/render window; steps at indices >= patternLength keep their data but
  // do not play or render. Shrinking the window is therefore non-destructive.
  patternLength: number;
  steps: Step[];
  // Whether this slot is an active track. The slot always exists (the pool is a
  // fixed-length array); disabling is non-destructive — steps/params are kept.
  enabled: boolean;
}

export interface Project {
  schemaVersion: 2;
  bpm: number;
  // Fixed-length pool (TRACK_POOL_SIZE) — see factory.ts. The length invariant
  // is enforced by ProjectSchema and normalizeTrackPool, not the TS type (a
  // 32-element tuple type is not worth writing).
  tracks: ProjectTrack[];
}
```

`activeParams` below it is unchanged.

- [ ] **Step 4: Update the factory**

Replace the body of `packages/shared/src/project/factory.ts` (keep the existing imports) so it reads:

```ts
// Fixed pool of track slots. The array is always this long on the wire and in
// memory; "add/remove track" toggles a slot's `enabled` flag (no structural
// sync op, no index shift). Sized for the eventual per-user vision (up to 4
// users x up to 8 tracks) so the storage shape is migrated exactly once.
export const TRACK_POOL_SIZE = 32;
// A fresh/new project starts with this many enabled slots (the four tracks
// users see today). The rest of the pool is present but disabled.
export const DEFAULT_ENABLED_TRACKS = 4;

export function freshStep(): Step {
  return {
    note: null,
    octave: 4,
    length: 1,
    velocity: 0.8,
    muted: false,
    isChord: false,
    chordType: 'maj',
  };
}

export function freshTrack(enabled = true): ProjectTrack {
  return {
    engineType: 'synth',
    engines: {
      synth: structuredClone(DEFAULT_SYNTH_PARAMS),
      kick:  structuredClone(DEFAULT_KICK_PARAMS),
      hat:   structuredClone(DEFAULT_HAT_PARAMS),
      snare: structuredClone(DEFAULT_SNARE_PARAMS),
      clap:  structuredClone(DEFAULT_CLAP_PARAMS),
    },
    mixer: { ...DEFAULT_MIXER_STATE },
    patternLength: 16,
    steps: Array.from({ length: 64 }, () => freshStep()),
    enabled,
  };
}

export function freshProject(): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: 120,
    tracks: Array.from({ length: TRACK_POOL_SIZE }, (_, i) =>
      freshTrack(i < DEFAULT_ENABLED_TRACKS),
    ),
  };
}
```

- [ ] **Step 5: Re-export the new constants**

In `packages/shared/src/project/index.ts`, update the factory re-export line:

```ts
export { freshStep, freshTrack, freshProject, TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from './factory.js';
```

- [ ] **Step 6: Run the test**

Run: `npm test -w @fiddle/shared -- src/project/factory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/project/factory.ts packages/shared/src/project/types.ts packages/shared/src/project/index.ts packages/shared/src/project/factory.test.ts
git commit -m "feat(shared): 32-slot track pool with per-slot enabled flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Shared — Zod schema (`enabled` + length 32)

**Files:**
- Modify: `packages/shared/src/project/schema.ts`
- Test: `packages/shared/src/project/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/project/schema.test.ts` (inside the existing top-level `describe`, or add a new one — match the file's style):

```ts
import { freshProject, TRACK_POOL_SIZE } from './factory.js';
// ^ add to the existing imports at the top if not already present.

describe('variable track pool schema', () => {
  it('accepts a freshProject (32 slots, each with enabled)', () => {
    expect(ProjectSchema.safeParse(freshProject()).success).toBe(true);
  });

  it('rejects a project with the old length of 4', () => {
    const p = freshProject();
    p.tracks = p.tracks.slice(0, 4);
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a track missing enabled', () => {
    const p = freshProject();
    delete (p.tracks[0] as { enabled?: boolean }).enabled;
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });

  it('TrackSchema.enabled validates a boolean leaf', () => {
    expect(Schemas.Track.shape.enabled.safeParse(true).success).toBe(true);
    expect(Schemas.Track.shape.enabled.safeParse('yes').success).toBe(false);
  });
});
```

(If `ProjectSchema`/`Schemas` aren't imported in the test yet, add `import { ProjectSchema, Schemas } from './schema.js';`.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- src/project/schema.test.ts`
Expected: FAIL — `enabled` not in `TrackSchema`; length is 4.

- [ ] **Step 3: Update the schema**

In `packages/shared/src/project/schema.ts`:

Add `enabled` to `TrackSchema` (after `steps`):

```ts
const TrackSchema = z.object({
  engineType: EngineTypeSchema,
  engines: EnginesMapSchema,
  mixer: MixerSchema,
  // Track loop-window length (steps). The buffer below is fixed at 64.
  patternLength: z.number().int().min(1).max(64),
  steps: z.array(StepSchema).length(64),
  // Whether this pool slot is an active track. Always present post-normalization.
  enabled: z.boolean(),
});
```

Change `ProjectSchema.tracks` length. At the top of the file add the import:

```ts
import { TRACK_POOL_SIZE } from './factory.js';
```

and update:

```ts
export const ProjectSchema = z.object({
  schemaVersion: z.literal(2),
  bpm: z.number().int().min(40).max(240),
  tracks: z.array(TrackSchema).length(TRACK_POOL_SIZE),
});
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @fiddle/shared -- src/project/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/schema.ts packages/shared/src/project/schema.test.ts
git commit -m "feat(shared): schema validates enabled flag + 32-slot pool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Shared — accept-list (`enabled` path + bound)

**Files:**
- Modify: `packages/shared/src/project/accept-list.ts`
- Test: `packages/shared/src/project/accept-list.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/project/accept-list.test.ts` (match existing imports/style; `validatePathAndValue` and `indicesInRange` are exported from `./accept-list.js`):

```ts
describe('enabled flag path', () => {
  it('tracks.<i>.enabled is writable and accepts a boolean', () => {
    expect(validatePathAndValue('tracks.5.enabled', true)).toEqual({ ok: true });
  });

  it('rejects a non-boolean enabled value', () => {
    expect(validatePathAndValue('tracks.5.enabled', 'yes').ok).toBe(false);
  });

  it('allows track indices up to 31 and rejects 32', () => {
    expect(indicesInRange('tracks.31.enabled')).toBe(true);
    expect(indicesInRange('tracks.32.enabled')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- src/project/accept-list.test.ts`
Expected: FAIL — `tracks.*.enabled` not writable; index 31 rejected (bound is 4).

- [ ] **Step 3: Update the accept-list**

In `packages/shared/src/project/accept-list.ts`:

Add the pattern (e.g. right after the `patternLength` entry in `PATTERNS`):

```ts
  ['tracks', '*', 'engineType'],
  ['tracks', '*', 'patternLength'],
  ['tracks', '*', 'enabled'],
```

Replace the hard-coded `TRACK_COUNT` with the shared constant. At the top add:

```ts
import { TRACK_POOL_SIZE } from './factory.js';
```

and change the constant line (currently `const TRACK_COUNT = 4;`) to:

```ts
const TRACK_COUNT = TRACK_POOL_SIZE;
```

Add an `enabled` branch in `resolveLeafSchema`, after the `patternLength` branch:

```ts
  if (trackKey === 'patternLength' && tokens.length === 3) {
    return trackShape.patternLength;
  }

  if (trackKey === 'enabled' && tokens.length === 3) {
    return trackShape.enabled;
  }
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @fiddle/shared -- src/project/accept-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/accept-list.ts packages/shared/src/project/accept-list.test.ts
git commit -m "feat(shared): accept-list allows tracks.*.enabled, bound to pool size

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Shared — `normalizeTrackPool`

**Files:**
- Create: `packages/shared/src/project/normalize.ts`
- Modify: `packages/shared/src/project/index.ts`
- Test: `packages/shared/src/project/normalize.test.ts` (**new**)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/project/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeTrackPool } from './normalize.js';
import { freshProject, freshTrack, TRACK_POOL_SIZE } from './factory.js';
import type { Project } from './types.js';

describe('normalizeTrackPool', () => {
  it('pads a legacy 4-track project to TRACK_POOL_SIZE slots', () => {
    const legacy = {
      schemaVersion: 2,
      bpm: 128,
      tracks: Array.from({ length: 4 }, () => freshTrack(true)),
    } as unknown as Project;
    // simulate legacy: no enabled field at all
    legacy.tracks.forEach(t => delete (t as { enabled?: boolean }).enabled);

    const out = normalizeTrackPool(legacy);
    expect(out.tracks).toHaveLength(TRACK_POOL_SIZE);
    // original 4 default to enabled
    expect(out.tracks.slice(0, 4).every(t => t.enabled)).toBe(true);
    // padded slots are disabled
    expect(out.tracks.slice(4).every(t => t.enabled === false)).toBe(true);
    // unrelated fields preserved
    expect(out.bpm).toBe(128);
  });

  it('preserves an explicit enabled value on existing slots', () => {
    const p = {
      schemaVersion: 2,
      bpm: 120,
      tracks: [freshTrack(true), freshTrack(false), freshTrack(true), freshTrack(true)],
    } as unknown as Project;
    const out = normalizeTrackPool(p);
    expect(out.tracks.slice(0, 4).map(t => t.enabled)).toEqual([true, false, true, true]);
  });

  it('is idempotent on an already-normalized project (returns it unchanged)', () => {
    const p = freshProject();
    expect(normalizeTrackPool(p)).toBe(p);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/shared -- src/project/normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `normalizeTrackPool`**

Create `packages/shared/src/project/normalize.ts`:

```ts
import type { Project, ProjectTrack } from './types.js';
import { freshTrack, TRACK_POOL_SIZE } from './factory.js';

// Bring any project up to the fixed track-pool shape: exactly TRACK_POOL_SIZE
// slots, each with a boolean `enabled`. Used at every deserialize boundary
// (client localStorage/file/snapshot, server snapshot load) so a legacy
// 4-track project never reaches code that assumes 32 slots.
//
// Semantics: a stored slot with no `enabled` is treated as enabled (it was an
// active track before this feature); padded slots are disabled. Idempotent —
// an already-normalized project is returned by reference (fast path), so this
// is cheap to call defensively.
export function normalizeTrackPool(project: Project): Project {
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  const alreadyNormal =
    tracks.length === TRACK_POOL_SIZE &&
    tracks.every(t => typeof t.enabled === 'boolean');
  if (alreadyNormal) return project;

  const out: ProjectTrack[] = [];
  for (let i = 0; i < TRACK_POOL_SIZE; i++) {
    const existing = tracks[i];
    if (existing) {
      out.push({
        ...existing,
        enabled: typeof existing.enabled === 'boolean' ? existing.enabled : true,
      });
    } else {
      out.push(freshTrack(false));
    }
  }
  return { ...project, tracks: out };
}
```

- [ ] **Step 4: Re-export it**

In `packages/shared/src/project/index.ts`, add:

```ts
export { normalizeTrackPool } from './normalize.js';
```

- [ ] **Step 5: Run the test**

Run: `npm test -w @fiddle/shared -- src/project/normalize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full shared suite + typecheck**

Run: `npm test -w @fiddle/shared && npm run typecheck -w @fiddle/shared`
Expected: PASS. (Catches any existing shared test that hard-coded 4 tracks — fix by using `freshProject()`/`TRACK_POOL_SIZE` if found.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/project/normalize.ts packages/shared/src/project/index.ts packages/shared/src/project/normalize.test.ts
git commit -m "feat(shared): normalizeTrackPool pads legacy projects to 32 slots

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Client — storage reconcile + replaceProject

**Files:**
- Modify: `packages/client/src/project/storage.ts`
- Test: `packages/client/src/project/storage.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/client/src/project/storage.test.ts` (match its imports; `reconcileWithDefaults`, `replaceProject` are exported from `./storage`):

```ts
import { TRACK_POOL_SIZE } from '@fiddle/shared';

describe('track pool reconcile', () => {
  it('reconcileWithDefaults pads a 4-track save to 32 slots, first 4 enabled', () => {
    const legacy = { schemaVersion: 2, bpm: 120, tracks: [{}, {}, {}, {}] };
    const out = reconcileWithDefaults(legacy);
    expect(out.tracks).toHaveLength(TRACK_POOL_SIZE);
    expect(out.tracks.slice(0, 4).every(t => t.enabled)).toBe(true);
    expect(out.tracks.slice(4).every(t => t.enabled === false)).toBe(true);
  });

  it('replaceProject copies enabled across all slots', () => {
    const target = freshProject();
    const source = freshProject();
    source.tracks[4].enabled = true;   // an added track
    source.tracks[0].enabled = false;  // a removed default
    replaceProject(target, source);
    expect(target.tracks[4].enabled).toBe(true);
    expect(target.tracks[0].enabled).toBe(false);
  });
});
```

(Ensure `freshProject` is imported in the test — it comes from `../project` or `@fiddle/shared`; match what the file already uses.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- src/project/storage.test.ts`
Expected: FAIL — reconcile yields 4 tracks / no `enabled`; `replaceProject` ignores `enabled` and only touches 4 slots.

- [ ] **Step 3: Update `reconcileWithDefaults` and `reconcileTrack`**

In `packages/client/src/project/storage.ts`:

Add the import at the top (alongside the existing `freshProject, freshTrack` import from `./factory`):

```ts
import { TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS } from '@fiddle/shared';
```

Give `reconcileTrack` an `enabled` parameter and set it on the result. Change its signature and the returned object:

```ts
function reconcileTrack(loaded: unknown, enabled: boolean): ProjectTrack {
  const fresh = freshTrack();
  const t = (typeof loaded === 'object' && loaded !== null) ? (loaded as Partial<ProjectTrack>) : {};
  const loadedEngines = (t as any).engines ?? {};

  const reconciled: ProjectTrack = {
    engineType: (t.engineType as ProjectTrack['engineType']) ?? fresh.engineType,
    engines: {
      synth: deepMerge(SynthEngine.DEFAULT_PARAMS, loadedEngines.synth),
      kick:  deepMerge(KickEngine.DEFAULT_PARAMS,  loadedEngines.kick),
      hat:   deepMerge(HatEngine.DEFAULT_PARAMS,   loadedEngines.hat),
      snare: deepMerge(SnareEngine.DEFAULT_PARAMS, loadedEngines.snare),
      clap:  deepMerge(ClapEngine.DEFAULT_PARAMS,  loadedEngines.clap),
    },
    mixer: deepMerge(DEFAULT_MIXER_STATE, t.mixer),
    patternLength: typeof t.patternLength === 'number'
      ? Math.max(1, Math.min(64, t.patternLength))
      : fresh.patternLength,
    steps: reconcileSteps(t.steps, fresh.steps),
    // A stored slot with an explicit enabled keeps it; a legacy slot with none
    // falls back to the position-based default the caller passes.
    enabled: typeof t.enabled === 'boolean' ? t.enabled : enabled,
  };

  const legacy = t as { playMode?: 'mono' | 'chord' };
  if (legacy.playMode === 'chord') {
    reconciled.engines.synth.mode = 'poly';
  }

  return reconciled;
}
```

Update `reconcileWithDefaults` to span the pool:

```ts
export function reconcileWithDefaults(loaded: unknown): Project {
  const fresh = freshProject();
  const p = (typeof loaded === 'object' && loaded !== null) ? (loaded as any) : {};
  const tracks = Array.isArray(p.tracks) ? p.tracks : [];

  const out: Project = {
    ...p,                                              // forward-compat: keep unknown extras
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: typeof p.bpm === 'number' ? p.bpm : fresh.bpm,
    // Pad to the full pool. Slots present in the legacy save default to enabled
    // (they were active tracks); slots beyond what was stored, but within the
    // original default count, also default enabled; the rest are disabled.
    tracks: Array.from({ length: TRACK_POOL_SIZE }, (_, i) =>
      reconcileTrack(tracks[i], i < Math.max(DEFAULT_ENABLED_TRACKS, tracks.length)),
    ),
  };

  return out;
}
```

- [ ] **Step 4: Update `replaceProject`**

In the same file, change the loop bound and copy `enabled`:

```ts
export function replaceProject(target: Project, source: Project): void {
  target.schemaVersion = source.schemaVersion;
  target.bpm = source.bpm;

  for (let i = 0; i < TRACK_POOL_SIZE; i++) {
    const t = target.tracks[i];
    const s = source.tracks[i];

    t.engineType = s.engineType;
    t.patternLength = s.patternLength;
    t.enabled = s.enabled;

    for (const engine of ENGINE_KEYS) {
      Object.assign(t.engines[engine], s.engines[engine]);
    }

    Object.assign(t.mixer, s.mixer);

    for (let j = 0; j < 64; j++) {
      Object.assign(t.steps[j], s.steps[j]);
    }
  }
}
```

- [ ] **Step 5: Run the test**

Run: `npm test -w @fiddle/client -- src/project/storage.test.ts`
Expected: PASS. (If other assertions in this file hard-coded `tracks.length === 4`, update them to `TRACK_POOL_SIZE`.)

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/project/storage.ts packages/client/src/project/storage.test.ts
git commit -m "feat(client): reconcile + replaceProject span the 32-slot pool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Client — normalize snapshot on receipt

**Files:**
- Modify: `packages/client/src/sync/messageDispatch.ts`
- Test: `packages/client/src/sync/messageDispatch.test.ts` (**new** — verify none exists first; if one exists, append)

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/sync/messageDispatch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { dispatchServerMessage, type DispatchDeps } from './messageDispatch.js';
import { freshProject, TRACK_POOL_SIZE, type Project, type ServerMessage } from '@fiddle/shared';

function deps(project: Project): DispatchDeps {
  return {
    project,
    wsClient: { recordOpIdSeen: vi.fn() } as unknown as DispatchDeps['wsClient'],
    outbox: { onLive: vi.fn(), onEcho: vi.fn(), onNack: vi.fn() } as unknown as DispatchDeps['outbox'],
    onFatalError: vi.fn(),
  };
}

describe('snapshot normalization', () => {
  it('pads a legacy 4-track snapshot to 32 slots before applying', () => {
    const target = freshProject();
    const legacy = freshProject();
    legacy.tracks = legacy.tracks.slice(0, 4); // simulate an old server snapshot
    const msg: ServerMessage = { v: 1, type: 'snapshot', opId: 0, project: legacy };

    dispatchServerMessage(msg, deps(target));

    expect(target.tracks).toHaveLength(TRACK_POOL_SIZE);
    expect(target.tracks.slice(0, 4).every(t => t.enabled)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- src/sync/messageDispatch.test.ts`
Expected: FAIL — `replaceProject` reads `source.tracks[i]` for i≥4 (undefined) → throws, or target stays length 32 with stale data. Either way the assertion on enabled/normalization fails.

- [ ] **Step 3: Normalize in the snapshot case**

In `packages/client/src/sync/messageDispatch.ts`:

Add to imports:

```ts
import { normalizeTrackPool } from '@fiddle/shared';
```

Change the `snapshot` case to normalize first:

```ts
    case 'snapshot':
      // Programmatic bulk write — suppress so the sync watchers don't treat the
      // incoming snapshot as a flurry of local edits and echo it all back out.
      // Normalize first so a snapshot from an older (pre-pool) server can't
      // under-fill the fixed 32-slot model the client assumes.
      enterSuppress();
      try {
        replaceProject(deps.project, normalizeTrackPool(msg.project));
      } finally {
        exitSuppress();
      }
      resetApplyOpState();
      return;
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @fiddle/client -- src/sync/messageDispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sync/messageDispatch.ts packages/client/src/sync/messageDispatch.test.ts
git commit -m "feat(client): normalize incoming snapshots to the 32-slot pool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Client — useSynth (loops, enabled watcher + gate, add/remove)

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`
- Modify: `packages/client/src/sync/synthContext.ts` (expose new members — confirm exact type/shape during the task)
- Test: `packages/client/src/composables/useSynth.test.ts`

**Context:** `useSynth.ts` has `for (let i = 0; i < 4; i++)` loops at (approx) lines 357 (trackGains/analysers), 393 (`updateMixerGains`), 404 (initial engine build), 427 (per-track watcher block), and 619 (sequencer tick). All become `TRACK_POOL_SIZE`. The composable already mocks Web Audio in tests and drives inbound frames via a fake `WsClient`; the existing `session-scoped connection` describe shows the `boot()` / `built[0]._opts.onMessage(...)` harness.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/composables/useSynth.test.ts` (reuse the existing `boot()` helper and `freshProject`/`snapshot`/`sync.complete` patterns from the `session-scoped connection` describe). Add:

```ts
import { TRACK_POOL_SIZE } from '@fiddle/shared';

describe('variable track count', () => {
  it('addTrack enables the lowest-index disabled slot and emits a leaf op', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    built[0]._opts.send.mockClear?.();

    synth.addTrack();
    await nextTick();

    expect(synth.project.tracks[4].enabled).toBe(true);
    expect(synth.enabledTrackCount.value).toBe(5);
    // a tracks.4.enabled op was emitted
    const sent = built[0]._opts.send.mock.calls.map((c: any[]) => c[0]);
    expect(sent.some((m: any) => m.type === 'set' && m.path.join('.') === 'tracks.4.enabled' && m.value === true)).toBe(true);
  });

  it('removeTrack disables that slot but refuses to drop below 1 enabled', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });

    synth.removeTrack(3);
    await nextTick();
    expect(synth.project.tracks[3].enabled).toBe(false);
    expect(synth.enabledTrackCount.value).toBe(3);

    // drop to one, then attempt to remove the last — must be refused
    synth.removeTrack(2);
    synth.removeTrack(1);
    await nextTick();
    expect(synth.enabledTrackCount.value).toBe(1);
    synth.removeTrack(0);
    await nextTick();
    expect(synth.enabledTrackCount.value).toBe(1); // unchanged
    expect(synth.project.tracks[0].enabled).toBe(true);
  });

  it('exposes all TRACK_POOL_SIZE slots in project.tracks', async () => {
    const { synth } = await boot();
    expect(synth.project.tracks).toHaveLength(TRACK_POOL_SIZE);
  });
});
```

(If the existing harness exposes the fake socket's send as something other than `built[0]._opts.send`, adjust the accessor to match the file — read the `session-scoped connection` tests to confirm the exact handle before writing.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- src/composables/useSynth.test.ts`
Expected: FAIL — `addTrack`/`removeTrack`/`enabledTrackCount` are undefined.

- [ ] **Step 3: Widen the init/tick loops to the pool size**

In `packages/client/src/composables/useSynth.ts`, add to the `@fiddle/shared` import (find the existing import from `@fiddle/shared` near the top):

```ts
import { TRACK_POOL_SIZE } from '@fiddle/shared';
```

Replace each `for (let i = 0; i < 4; i++)` with `for (let i = 0; i < TRACK_POOL_SIZE; i++)` at the trackGains/analysers loop (~357), the `updateMixerGains` loop (~393), the initial engine-build loop (~404), and the per-track watcher loop (~427).

In `updateMixerGains` (~391-401), gate audibility on `enabled` and only let enabled tracks drive solo:

```ts
  const updateMixerGains = () => {
    const anySoloed = project.tracks.some(t => t.enabled && t.mixer?.soloed);
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      const track = project.tracks[i];
      const audible = track.enabled && (anySoloed
        ? (track.mixer.soloed && !track.mixer.muted)
        : !track.mixer.muted);
      const targetGain = audible ? sliderToLinearGain(track.mixer.volume) : 0;
      trackGains[i].gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
    }
  };
```

- [ ] **Step 4: Add the `enabled` watcher (audio gate + sync emit)**

Inside the per-track watcher block (the `for` loop that starts ~427), after the `patternLength` watcher, add:

```ts
      // enabled is a syncable leaf with no engine of its own — disabling a
      // track must silence it (updateMixerGains zeroes a disabled slot's gain;
      // the sequencer also skips disabled slots). Sync-flush + the same
      // suppression/readiness guard as the other leaf watchers.
      watch(
        () => project.tracks[i].enabled,
        (newVal, oldVal) => {
          updateMixerGains();
          if (outbox && syncReady && !isApplyingFromNetwork()) {
            outbox.enqueue(['tracks', i, 'enabled'], newVal, oldVal, gestureEndForLeaf('enabled'));
          }
        },
        { flush: 'sync' },
      );
```

(Confirm `gestureEndForLeaf` accepts an arbitrary leaf name; `'patternLength'`/`'engineType'` are already passed to it. If it switches on known names, add an `'enabled'` case mirroring `'patternLength'` — a discrete, non-gesture leaf.)

- [ ] **Step 5: Gate the sequencer tick on `enabled`**

In the sequencer callback (~619), widen the loop and skip disabled slots:

```ts
        for (let i = 0; i < TRACK_POOL_SIZE; i++) {
          const track = project.tracks[i];
          if (!track.enabled) continue;
          const step = track.steps[stepIndex % track.patternLength];
          // ...unchanged trigger logic below...
```

- [ ] **Step 6: Add `addTrack` / `removeTrack` / `enabledTrackCount` and expose them**

Inside `useSynth()` (after `focusedTrack` is defined, before the return), add:

```ts
  const enabledTrackCount = computed(() => project.tracks.filter(t => t.enabled).length);

  // Add a track = enable the lowest-index disabled slot (fills a freed hole if
  // there is one). No-op when the pool is full.
  const addTrack = (): void => {
    const idx = project.tracks.findIndex(t => !t.enabled);
    if (idx !== -1) project.tracks[idx].enabled = true;
  };

  // Remove a track = disable that slot (non-destructive). Refused when it would
  // leave zero enabled tracks.
  const removeTrack = (index: number): void => {
    if (index < 0 || index >= TRACK_POOL_SIZE) return;
    if (!project.tracks[index].enabled) return;
    if (enabledTrackCount.value <= 1) return;
    project.tracks[index].enabled = false;
  };
```

Add them to the object the composable returns (alongside `selectTrack`, `getTrackEngineType`, etc.):

```ts
    addTrack,
    removeTrack,
    enabledTrackCount,
```

- [ ] **Step 7: Expose the new members on the context type**

`StudioView.vue` injects `SYNTH_CONTEXT` (`packages/client/src/sync/synthContext.ts`). Confirm whether that file types the context as `ReturnType<typeof useSynth>` (in which case no edit is needed) or lists members explicitly. If explicit, add `addTrack`, `removeTrack`, `enabledTrackCount` to the type.

- [ ] **Step 8: Run the tests**

Run: `npm test -w @fiddle/client -- src/composables/useSynth.test.ts`
Expected: PASS, including the existing tests (the `roomLoading` and session-scoped tests must stay green).

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts packages/client/src/sync/synthContext.ts
git commit -m "feat(client): useSynth spans 32 slots; add/remove track + enabled sync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Client — `trackColor` helper

**Files:**
- Create: `packages/client/src/ui/trackColors.ts`
- Test: `packages/client/src/ui/trackColors.test.ts` (**new**)

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/ui/trackColors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { trackColor } from './trackColors.js';
import { TRACK_POOL_SIZE } from '@fiddle/shared';

describe('trackColor', () => {
  it('keeps the original four colors for indices 0-3', () => {
    expect(trackColor(0)).toBe('#00f0ff');
    expect(trackColor(1)).toBe('#c084fc');
    expect(trackColor(2)).toBe('#fb923c');
    expect(trackColor(3)).toBe('#4ade80');
  });

  it('returns a non-empty color string for every pool slot', () => {
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      expect(trackColor(i)).toMatch(/\S/);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/client -- src/ui/trackColors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `packages/client/src/ui/trackColors.ts`:

```ts
// Per-track accent color. The first four slots keep the established palette
// (cyan / purple / orange / green) for visual continuity with the pre-pool UI;
// the rest are generated by rotating the hue wheel so every one of the 32 pool
// slots gets a distinct, stable color.
const BASE_COLORS = ['#00f0ff', '#c084fc', '#fb923c', '#4ade80'] as const;

export function trackColor(index: number): string {
  if (index < BASE_COLORS.length) return BASE_COLORS[index];
  // Golden-angle hue rotation gives well-separated hues without a lookup table.
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue}, 80%, 65%)`;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @fiddle/client -- src/ui/trackColors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/ui/trackColors.ts packages/client/src/ui/trackColors.test.ts
git commit -m "feat(client): trackColor helper for any pool slot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Client — StudioView add/remove UI

**Files:**
- Modify: `packages/client/src/views/StudioView.vue`

No unit test (we do not mount `.vue` files — per AGENTS.md). Verified in the browser at Task 11.

- [ ] **Step 1: Replace the `TRACK_COLORS` array with the helper**

In `packages/client/src/views/StudioView.vue`:

Remove the local definition (line ~381): `const TRACK_COLORS = ['#00f0ff', ...];`

Add an import in the `<script setup>` block:

```ts
import { trackColor } from '../ui/trackColors';
```

Replace every `TRACK_COLORS[i]` / `TRACK_COLORS[activeTrackIndex]` usage in the template and script with `trackColor(i)` / `trackColor(activeTrackIndex)`. (There are ~13 usages — search the file for `TRACK_COLORS` and replace each.)

- [ ] **Step 2: Pull the new members from the context**

In the destructure of `synth` (currently ends with `getTrackEngineType, roomLoading,`), add:

```ts
  addTrack,
  removeTrack,
  enabledTrackCount,
```

- [ ] **Step 3: Render only enabled tracks + add/remove controls in the overview**

Replace the overview block (the `<div v-if="activeTrackIndex === null" class="overview-container">` … `</div>`) with one that iterates only enabled slots (preserving the true slot index) and adds the controls:

```html
    <!-- Track Overview Screen (enabled slots only) -->
    <div v-if="activeTrackIndex === null" class="overview-container">
      <div class="tracks-grid">
        <div
          v-for="entry in enabledTrackEntries"
          :key="entry.index"
          class="track-cell"
        >
          <button
            v-if="enabledTrackCount > 1"
            class="remove-track-btn"
            title="Remove this track"
            @click.stop="removeTrack(entry.index)"
          >×</button>
          <Tracker
            :steps="entry.track.steps"
            :currentStep="currentStep"
            :title="`Track ${entry.index + 1} [${getTrackEngineType(entry.index).toUpperCase()}]`"
            :color="trackColor(entry.index)"
            :isFocused="false"
            :trackId="entry.index"
            :engineType="getTrackEngineType(entry.index)"
            :mode="project.tracks[entry.index].engines.synth.mode"
            :patternLength="entry.track.patternLength"
            @select-track="selectTrack(entry.index)"
            @clear="onClear"
            @shift="onShift"
            @fill="onFill"
            @set-length="onSetLength"
          />
        </div>

        <button
          v-if="enabledTrackCount < TRACK_POOL_SIZE"
          class="add-track-btn"
          @click="addTrack"
        >+ ADD TRACK</button>
      </div>
    </div>
```

Add the supporting computed + import in `<script setup>`:

```ts
import { TRACK_POOL_SIZE } from '@fiddle/shared';

// Enabled slots paired with their true pool index (used for color, sync paths,
// and the focused view). Disabled slots are filtered out; order is slot order.
const enabledTrackEntries = computed(() =>
  project.tracks
    .map((track, index) => ({ track, index }))
    .filter(e => e.track.enabled),
);
```

(`computed` is already imported in this file; `TRACK_POOL_SIZE` is new. Make `TRACK_POOL_SIZE` available to the template by referencing it through the computed condition above — Vue `<script setup>` top-level bindings are template-visible, so the import suffices.)

- [ ] **Step 4: Add styles**

Add to the `<style scoped>` block:

```css
.track-cell {
  position: relative;
}
.remove-track-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 5;
  width: 22px;
  height: 22px;
  line-height: 1;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #181818;
  color: #888;
  cursor: pointer;
  font-weight: bold;
}
.remove-track-btn:hover {
  color: #fff;
  border-color: #ff4136;
  background: #2a1414;
}
.add-track-btn {
  align-self: center;
  min-width: 120px;
  min-height: 60px;
  border: 1px dashed #333;
  border-radius: 4px;
  background: #141414;
  color: #888;
  font-family: monospace;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.add-track-btn:hover {
  color: #00f0ff;
  border-color: #00f0ff;
  background: #181818;
}
```

- [ ] **Step 5: Typecheck the client**

Run: `npm run typecheck -w @fiddle/client`
Expected: PASS (no unused `TRACK_COLORS`, all `trackColor` usages resolve).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(client): add/remove track UI in the overview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Client — TrackMixer renders enabled slots only

**Files:**
- Modify: `packages/client/src/components/TrackMixer.vue`

No unit test (no `.vue` mounting). Verified in the browser at Task 11.

- [ ] **Step 1: Filter to enabled slots while preserving the true index**

In `packages/client/src/components/TrackMixer.vue`:

The `v-for` (line ~13) is `v-for="(track, index) in trackStates"` and uses `index` for `TRACK_COLORS[index]`, `TRK {{ index + 1 }}`, and sync paths `['tracks', index, 'mixer', ...]`. Those indices must remain the **true pool index**, so introduce a computed that pairs+filters, and iterate it.

Add to `<script setup>` (a `computed` import may be needed — check the file's existing imports):

```ts
import { computed } from 'vue';
import { trackColor } from '../ui/trackColors';

const enabledChannels = computed(() =>
  props.trackStates
    .map((track, index) => ({ track, index }))
    .filter(c => c.track.enabled),
);
```

Change the template loop to:

```html
      <div
        v-for="chan in enabledChannels"
        :key="chan.index"
        ...
        :style="{ '--track-color': trackColor(chan.index) }"
      >
```

and within it replace `track` with `chan.track` and `index` with `chan.index` everywhere (the `TRK` label, `isTrackTriggered(chan.index)`, the `syncPath`/`gesture-end` `['tracks', chan.index, 'mixer', 'volume']`, etc.).

Remove the local `const TRACK_COLORS = [...]` (line ~84).

- [ ] **Step 2: Typecheck the client**

Run: `npm run typecheck -w @fiddle/client`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/TrackMixer.vue
git commit -m "feat(client): mixer renders enabled tracks only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Server — normalize loaded session project

**Files:**
- Modify: `packages/server/src/sync/ConnectionHandler.ts`
- Test: `packages/server/src/sync/ConnectionHandler.test.ts`

**Context:** On first join, `ConnectionHandler` seeds the room from `loadSession` (line ~204-209: `seed = () => loaded.project;`). Normalizing here guarantees the in-memory room project has all 32 slots, so `enabled` ops for any slot apply and the served snapshot is full-width. The default `seed = freshProject` is already 32-wide.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/sync/ConnectionHandler.test.ts` (reuse the file's existing harness for building a handler with an injected `loadSession` and capturing sent messages — read the file to match its exact setup helpers before writing). The test injects a loader returning a legacy 4-track project and asserts the snapshot the client receives has 32 slots:

```ts
import { TRACK_POOL_SIZE, freshProject } from '@fiddle/shared';

it('normalizes a legacy 4-track session to the full pool before serving', async () => {
  const legacy = freshProject();
  legacy.tracks = legacy.tracks.slice(0, 4); // pre-pool stored project
  const loadSession = async () => ({ project: legacy });

  // Build the handler with this loadSession using the file's existing helper,
  // drive hello → force a snapshot, and capture the SnapshotMessage sent.
  // (Match the harness already used by other tests in this file.)
  const snapshot = await /* harness: connect + capture snapshot */;

  expect(snapshot.project.tracks).toHaveLength(TRACK_POOL_SIZE);
  expect(snapshot.project.tracks.slice(0, 4).every((t: any) => t.enabled)).toBe(true);
});
```

If the existing tests assert a snapshot is served with a specific shape, model this test on the closest one. If forcing a snapshot is awkward, an acceptable alternative assertion is on `store.peekProject(roomId)` after connect having 32 tracks.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w @fiddle/server -- src/sync/ConnectionHandler.test.ts`
Expected: FAIL — served/stored project has 4 tracks.

- [ ] **Step 3: Normalize the seed**

In `packages/server/src/sync/ConnectionHandler.ts`:

Add `normalizeTrackPool` to the `@fiddle/shared` import (the block importing `freshProject` at line ~14):

```ts
import {
  freshProject,
  normalizeTrackPool,
  // ...existing imports...
} from '@fiddle/shared';
```

Change the seed assignment (line ~209) from `seed = () => loaded.project;` to:

```ts
      seed = () => normalizeTrackPool(loaded.project);
```

- [ ] **Step 4: Run the test**

Run: `npm test -w @fiddle/server -- src/sync/ConnectionHandler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/sync/ConnectionHandler.ts packages/server/src/sync/ConnectionHandler.test.ts
git commit -m "feat(server): normalize loaded session project to the 32-slot pool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Full gate + browser verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. Fix any workspace test that still hard-codes 4 tracks (search the repo for `length(4)`, `< 4`, `[0, 1, 2, 3]`, `tracks).toHaveLength(4)` and update to the pool constant where it refers to the track pool).

- [ ] **Step 2: Run the server protocol e2e suite**

Run: `npm run test:e2e:server`
Expected: green (unchanged behavior; should remain 8/8 or whatever the current baseline is).

- [ ] **Step 3: Browser-verify (single session)**

Start `npm run dev`. With the Playwright MCP: create a throwaway session, confirm 4 tracks render. Click **+ ADD TRACK** → a 5th track appears; PLAY → it sequences. Remove a middle track via **×** → it disappears, others keep their data; the remove control disappears when one track remains. Confirm no console errors. **Close the browser when done.**

- [ ] **Step 4: Browser-verify (two clients converge)**

Open the same session in two browser contexts. Add a track in one → it appears in the other. Remove a track in one → it disappears in the other. Confirm no console errors. **Close the browser when done.**

- [ ] **Step 5: Report**

Report the gate output (test counts), the e2e result, and exactly what was observed in each browser check. Do not claim completion without this evidence (verification-before-completion).

---

## Self-review notes

- **Spec coverage:** data model (T1), schema (T2), accept-list + bound (T3), normalizer (T4), client deserialize boundaries — localStorage/file (T5), snapshot (T6), server load (T11) — `enabled` watcher + audio/sequencer gate + add/remove (T7), `trackColor` (T8), overview UI (T9), mixer (T10), migration-is-additive/no-bump (honored throughout — `PROJECT_SCHEMA_VERSION` untouched), tests + browser verify incl. two-client convergence (T12). No spec requirement is left without a task.
- **Type consistency:** `enabled: boolean`, `TRACK_POOL_SIZE`, `DEFAULT_ENABLED_TRACKS`, `normalizeTrackPool`, `freshTrack(enabled = true)`, `addTrack()`, `removeTrack(index)`, `enabledTrackCount` (a `ComputedRef<number>`, accessed as `.value` in tests and unwrapped in the template) are used consistently across tasks.
- **Known verify-points flagged for the implementer (not placeholders):** the exact fake-socket `send` handle in `useSynth.test.ts` (T7), whether `gestureEndForLeaf` needs an `'enabled'` case (T7), whether `synthContext.ts` types the context structurally or explicitly (T7), and the `ConnectionHandler.test.ts` harness for capturing a served snapshot (T11). Each names the file to read and what to confirm.
