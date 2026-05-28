# WebSocket Sync Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the WebSocket sync protocol designed in `docs/superpowers/specs/2026-05-28-websocket-sync-protocol-design.md`. After this work lands, two browsers on the same `/r/{roomId}` URL share live Project state: knob turns, step toggles, engine swaps, BPM, and mixer changes propagate via a server-authoritative event log; audio renders locally on each peer; identity is anonymous (server-issued color + handle) and per tab session.

**Architecture:** Single feature branch `feature/ws-sync-protocol` off `main` (`339cd98` at time of writing). Each task gets its own sub-branch `task/NN-<slug>` that merges into `feature/ws-sync-protocol` with `--no-ff` once verification gates are green. Phase 1 only: in-memory `RoomStore`, single Fastify process. Phase 2 (Redis-backed) is out of scope.

**Tech Stack:** Vue 3 + TypeScript + Vite + Vitest (client), Fastify 5 + `@fastify/websocket` 11 + tsx + Vitest (server), Zod for shared schemas, plain JSON over WebSockets for protocol.

---

## Spec reference

Implements `docs/superpowers/specs/2026-05-28-websocket-sync-protocol-design.md`. **Read it before starting any task.** This plan assumes the implementer is familiar with the message shapes (§"The envelope" through §"Heartbeat"), the server-side responsibilities (§"Server-side responsibilities"), and the client integration model (§"Client-side responsibilities"). When a task says "shape per spec §X", look it up.

## Source-of-truth context the implementer needs

Repo state at start (`main` at `339cd98`):

- npm workspaces monorepo. Three packages: `@fiddle/client` (Vue app), `@fiddle/server` (Fastify), `@fiddle/shared` (portable types).
- `@fiddle/shared/src/index.ts` currently re-exports four symbols: `EngineType`, `MixerState`, `DEFAULT_MIXER_STATE`, `PROJECT_SCHEMA_VERSION`.
- Client engine classes (`SynthEngine`, `KickEngine`, `HatEngine`, `SnareEngine`, `ClapEngine` at `packages/client/src/engine/*.ts`) each define a `*EngineParams` interface and export a `static readonly DEFAULT_PARAMS` constant. The full set of engines and their param shapes is the source of truth for what's syncable.
- `packages/client/src/project/factory.ts` defines `freshProject()`, `freshTrack()`, `freshStep()`. These currently pull `EngineClass.DEFAULT_PARAMS` from each engine.
- `packages/client/src/project/storage.ts` defines `loadProject`, `installAutoSave`, `serializeProject`, `deserializeProject`, `replaceProject`. The auto-save watcher persists `project` to `localStorage` on every mutation, debounced 500 ms.
- `packages/client/src/composables/useSynth.ts` is the singleton-as-composable that wires Vue reactive `project` to the audio graph. The "narrow per-slice watcher" pattern (one watcher per `project.tracks[i].engines[slice]`) is described in `docs/ARCHITECTURE.md` §6.
- `packages/server/src/routes/ws.ts` currently has a placeholder: on connect it sends `{type:"hello"}` and logs incoming messages.
- Baseline: 183 tests passing (182 client + 1 server smoke test), `vue-tsc --noEmit` clean, `tsc --noEmit` clean for server, `npm run build` for the workspace succeeds.

## File structure after the protocol lands

```
browser-synth/
├── packages/
│   ├── shared/src/
│   │   ├── index.ts                     # MODIFIED — re-export everything from new modules
│   │   ├── engines/
│   │   │   ├── synth.ts                 # NEW — SynthEngineParams + DEFAULT_PARAMS
│   │   │   ├── kick.ts                  # NEW
│   │   │   ├── hat.ts                   # NEW
│   │   │   ├── snare.ts                 # NEW
│   │   │   ├── clap.ts                  # NEW
│   │   │   └── index.ts                 # NEW — barrel
│   │   ├── project/
│   │   │   ├── types.ts                 # NEW — Project, ProjectTrack, EngineParamsMap (moved from client)
│   │   │   ├── factory.ts               # NEW — freshProject, freshTrack, freshStep (moved from client)
│   │   │   ├── schema.ts                # NEW — Zod schema for Project
│   │   │   └── accept-list.ts           # NEW — path accept-list + path-walk validator
│   │   └── protocol/
│   │       ├── types.ts                 # NEW — all message types (Envelope, SetOp, Hello, Welcome, etc.)
│   │       ├── schema.ts                # NEW — Zod schemas for inbound messages
│   │       ├── identity.ts              # NEW — PALETTE + HANDLES constants
│   │       └── version.ts               # NEW — PROTOCOL_VERSION = 1
│   ├── server/src/
│   │   ├── routes/
│   │   │   └── ws.ts                    # REWRITTEN — full lifecycle (replaces placeholder)
│   │   ├── room/
│   │   │   ├── RoomStore.ts             # NEW — interface
│   │   │   ├── InMemoryRoomStore.ts     # NEW — Phase 1 implementation
│   │   │   ├── InMemoryRoomStore.test.ts
│   │   │   ├── identity.ts              # NEW — assignIdentity(roomState)
│   │   │   ├── identity.test.ts
│   │   │   └── types.ts                 # NEW — RoomState, Identity, etc. (server-internal)
│   │   ├── sync/
│   │   │   ├── ConnectionHandler.ts     # NEW — per-socket handler (hello→welcome→ops…)
│   │   │   ├── ConnectionHandler.test.ts
│   │   │   ├── validate.ts              # NEW — path + value validation wrapper around shared
│   │   │   ├── validate.test.ts
│   │   │   ├── rate-limit.ts            # NEW — token-bucket per clientId
│   │   │   └── rate-limit.test.ts
│   │   └── server.ts                    # MODIFIED — instantiate InMemoryRoomStore, pass to ws route
│   └── client/src/
│       ├── engine/
│       │   ├── SynthEngine.ts           # MODIFIED — import params/defaults from @fiddle/shared
│       │   ├── KickEngine.ts            # MODIFIED — same
│       │   ├── HatEngine.ts             # MODIFIED — same
│       │   ├── SnareEngine.ts           # MODIFIED — same
│       │   └── ClapEngine.ts            # MODIFIED — same
│       ├── project/
│       │   ├── types.ts                 # MODIFIED — re-source from @fiddle/shared
│       │   ├── factory.ts               # MODIFIED — re-source from @fiddle/shared
│       │   └── index.ts                 # MODIFIED — re-export from shared
│       ├── sync/                        # NEW directory
│       │   ├── Outbox.ts                # NEW — throttle/coalesce/priorValue
│       │   ├── Outbox.test.ts
│       │   ├── WsClient.ts              # NEW — state machine, sessionStorage, reconnect
│       │   ├── WsClient.test.ts
│       │   ├── applyOp.ts               # NEW — inbound apply (setPath + suppress flag)
│       │   ├── applyOp.test.ts
│       │   ├── presence.ts              # NEW — roster + lastTouchedByPath reactive store
│       │   ├── presence.test.ts
│       │   └── roomId.ts                # NEW — URL parsing + history.replaceState
│       ├── composables/
│       │   └── useSynth.ts              # MODIFIED — wire Outbox into watchers + own applyingFromNetwork flag
│       └── components/
│           ├── Knob.vue                 # MODIFIED — accept activityColor prop, render fading ring
│           ├── RoomBar.vue              # NEW — top-bar roster chips (Owl, Fox, etc.)
│           ├── ErrorOverlay.vue         # NEW — fatal error UI (schema mismatch, room full)
│           └── App.vue                  # MODIFIED — mount RoomBar + ErrorOverlay
```

## Branch and merge conventions

- Sub-branches off `feature/ws-sync-protocol`, named `task/NN-<slug>` (e.g. `task/01-shared-engine-defaults`).
- After all verification commands in a task pass, merge with `git merge --no-ff task/NN-<slug>` into `feature/ws-sync-protocol`. Do not delete the sub-branch.
- **No push to `origin`** at any point during this plan unless the user explicitly requests it.
- **No merge to `main`** until the user explicitly approves it after reviewing the whole feature branch.

## Green gates that every task must satisfy before merge into `feature/ws-sync-protocol`

Per task verification differs (spelled out in each task), but every task ends with these still green at the repo level:

- `npm test` from repo root: all workspaces pass (counts grow as tests are added; never decrease).
- `npm run typecheck` from repo root: both client (`vue-tsc --noEmit`) and server (`tsc --noEmit`) clean.
- `npm run build` from repo root: client (`vue-tsc && vite build`) and server (`tsc`) both succeed.

If a task does not change client code and does not introduce shared schema changes that affect client compilation, the client checks can be skipped only with an explicit note in the task. Default is **run them all**.

---

## Task 1: Relocate engine `*EngineParams` types + `DEFAULT_PARAMS` to `@fiddle/shared`

**Scope:** Move the param-type interface and `DEFAULT_PARAMS` constant for each of the 5 engines from the engine class files into `@fiddle/shared`. The engine classes import them back. Pure refactor; zero behavior change. After this task, the server can `import { SynthEngineParams, DEFAULT_SYNTH_PARAMS } from '@fiddle/shared'` without dragging in any Audio/DOM types.

**Files:**
- Create: `packages/shared/src/engines/synth.ts`
- Create: `packages/shared/src/engines/kick.ts`
- Create: `packages/shared/src/engines/hat.ts`
- Create: `packages/shared/src/engines/snare.ts`
- Create: `packages/shared/src/engines/clap.ts`
- Create: `packages/shared/src/engines/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/client/src/engine/SynthEngine.ts`
- Modify: `packages/client/src/engine/KickEngine.ts`
- Modify: `packages/client/src/engine/HatEngine.ts`
- Modify: `packages/client/src/engine/SnareEngine.ts`
- Modify: `packages/client/src/engine/ClapEngine.ts`

- [ ] **Step 1: Create the per-engine shared modules**

For each of the 5 engines, copy the `*EngineParams` interface and the literal value of `DEFAULT_PARAMS` from the current engine file into a new file in `packages/shared/src/engines/`. Rename the exported constant from `DEFAULT_PARAMS` (which is class-scoped) to `DEFAULT_<ENGINE>_PARAMS` (file-scoped), so all five live in the same shared namespace without collision.

Example for `packages/shared/src/engines/synth.ts`:

```ts
import type { EngineType } from '../index.js';

export interface SynthEngineParams {
  mode: 'mono' | 'poly';
  osc1Type: 'sine' | 'square' | 'sawtooth' | 'triangle';
  osc1Level: number;
  osc1Coarse: number;
  osc1Fine: number;
  osc2Type: 'sine' | 'square' | 'sawtooth' | 'triangle';
  osc2Level: number;
  osc2Coarse: number;
  osc2Fine: number;
  filterCutoff: number;
  filterResonance: number;
  filterEnvAmount: number;
  filterEnv: { attack: number; decay: number; sustain: number; release: number };
  ampEnv: { attack: number; decay: number; sustain: number; release: number };
}

export const DEFAULT_SYNTH_PARAMS: SynthEngineParams = {
  // copy verbatim from packages/client/src/engine/SynthEngine.ts
  // existing static readonly DEFAULT_PARAMS value
};
```

Do this for all 5 engines. **The actual default values must be copied verbatim** from the current `DEFAULT_PARAMS` constants — any change in numeric defaults is a behavior change and fails the gate.

- [ ] **Step 2: Create the engines barrel**

`packages/shared/src/engines/index.ts`:

```ts
export * from './synth.js';
export * from './kick.js';
export * from './hat.js';
export * from './snare.js';
export * from './clap.js';
```

- [ ] **Step 3: Re-export from the top-level shared barrel**

Modify `packages/shared/src/index.ts` to add:

```ts
export * from './engines/index.js';
```

(Keep the existing four exports — `EngineType`, `MixerState`, `DEFAULT_MIXER_STATE`, `PROJECT_SCHEMA_VERSION` — unchanged.)

- [ ] **Step 4: Update engine classes to import from shared**

For each of the 5 engine files in `packages/client/src/engine/`:

1. Remove the local `*EngineParams` interface declaration.
2. Remove the `static readonly DEFAULT_PARAMS: ... = { ... }` declaration.
3. Add an import: `import { SynthEngineParams, DEFAULT_SYNTH_PARAMS } from '@fiddle/shared';` (adjust per engine).
4. Replace internal references from `SynthEngine.DEFAULT_PARAMS` to `DEFAULT_SYNTH_PARAMS`.
5. Re-export the type so existing consumers of `import { SynthEngineParams } from './SynthEngine'` keep working:
   ```ts
   export type { SynthEngineParams } from '@fiddle/shared';
   ```
   *(If the type wasn't exported from the engine file before, skip this — but most are.)*

- [ ] **Step 5: Update any consumer that read `EngineClass.DEFAULT_PARAMS`**

`packages/client/src/project/factory.ts` and possibly `packages/client/src/composables/useSynth.ts` reference `SynthEngine.DEFAULT_PARAMS` etc. via the class. Update those to use the new constants:

```ts
// Before
const engines: EngineParamsMap = {
  synth: structuredClone(SynthEngine.DEFAULT_PARAMS),
  ...
};

// After
import { DEFAULT_SYNTH_PARAMS, DEFAULT_KICK_PARAMS, ... } from '@fiddle/shared';
const engines: EngineParamsMap = {
  synth: structuredClone(DEFAULT_SYNTH_PARAMS),
  ...
};
```

- [ ] **Step 6: Run the full verification gate**

```bash
npm run typecheck
npm test
npm run build
```

Expected: 183 tests still pass (no test count change). All three commands clean.

- [ ] **Step 7: Commit and merge**

```bash
git add -A
git commit -m "refactor(shared): relocate engine param types + defaults to @fiddle/shared"
git checkout feature/ws-sync-protocol
git merge --no-ff task/01-shared-engine-defaults
```

---

## Task 2: Move `Project` / `ProjectTrack` / `EngineParamsMap` types + `freshProject` factory to `@fiddle/shared`

**Scope:** With engine defaults already in shared (Task 1), the project types can now move too. After this task, both client and server can construct a default `Project` from `@fiddle/shared`.

**Files:**
- Create: `packages/shared/src/project/types.ts`
- Create: `packages/shared/src/project/factory.ts`
- Create: `packages/shared/src/project/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/client/src/project/types.ts` (becomes re-export shim)
- Modify: `packages/client/src/project/factory.ts` (becomes re-export shim)
- Modify: `packages/client/src/project/index.ts` (unchanged surface, deeper sourcing)

- [ ] **Step 1: Create the shared project types**

`packages/shared/src/project/types.ts`:

```ts
import type {
  SynthEngineParams,
  KickEngineParams,
  HatEngineParams,
  SnareEngineParams,
  ClapEngineParams,
} from '../engines/index.js';
import type { EngineType, MixerState } from '../index.js';

export interface EngineParamsMap {
  synth: SynthEngineParams;
  kick: KickEngineParams;
  hat: HatEngineParams;
  snare: SnareEngineParams;
  clap: ClapEngineParams;
}

export interface Step {
  note: string;
  octave: number;
  length: number;
  velocity: number;
  mute: boolean;
  chordType: string;
}

export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;
  mixer: MixerState;
  steps: Step[];
}

export interface Project {
  schemaVersion: number;
  bpm: number;
  tracks: ProjectTrack[];
}

// Helper: which engine is "active" on a track
export function activeParams(track: ProjectTrack): EngineParamsMap[EngineType] {
  return track.engines[track.engineType];
}
```

(Confirm the actual `Step` field names match `packages/client/src/project/types.ts` — copy verbatim. Same for any other small types like `ChordType` enum if present.)

- [ ] **Step 2: Create the shared factory**

`packages/shared/src/project/factory.ts`:

```ts
import {
  DEFAULT_SYNTH_PARAMS,
  DEFAULT_KICK_PARAMS,
  DEFAULT_HAT_PARAMS,
  DEFAULT_SNARE_PARAMS,
  DEFAULT_CLAP_PARAMS,
} from '../engines/index.js';
import {
  DEFAULT_MIXER_STATE,
  PROJECT_SCHEMA_VERSION,
} from '../index.js';
import type { Project, ProjectTrack, Step } from './types.js';

export function freshStep(): Step {
  return {
    note: 'C',
    octave: 4,
    length: 1,
    velocity: 1.0,
    mute: false,
    chordType: 'single',
  };
}

export function freshTrack(engineType: 'synth' | 'kick' | 'hat' | 'snare' | 'clap'): ProjectTrack {
  return {
    engineType,
    engines: {
      synth: structuredClone(DEFAULT_SYNTH_PARAMS),
      kick: structuredClone(DEFAULT_KICK_PARAMS),
      hat: structuredClone(DEFAULT_HAT_PARAMS),
      snare: structuredClone(DEFAULT_SNARE_PARAMS),
      clap: structuredClone(DEFAULT_CLAP_PARAMS),
    },
    mixer: { ...DEFAULT_MIXER_STATE },
    steps: Array.from({ length: 16 }, () => freshStep()),
  };
}

export function freshProject(): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: 120,
    tracks: [
      freshTrack('synth'),
      freshTrack('kick'),
      freshTrack('hat'),
      freshTrack('snare'),
    ],
  };
}
```

(Re-check the current `freshProject` for any per-track defaults — e.g. mono/poly mode initialization, BPM value, default track engineTypes — and copy verbatim. Any divergence is a behavior change.)

- [ ] **Step 3: Create barrel**

`packages/shared/src/project/index.ts`:

```ts
export * from './types.js';
export * from './factory.js';
```

- [ ] **Step 4: Re-export from top-level shared barrel**

Modify `packages/shared/src/index.ts` to add:

```ts
export * from './project/index.js';
```

- [ ] **Step 5: Shim the client `types.ts` and `factory.ts`**

`packages/client/src/project/types.ts` becomes:

```ts
// All types now sourced from @fiddle/shared; this file is a re-export shim
// so existing internal imports (`../project/types`) keep working.
export * from '@fiddle/shared';
```

`packages/client/src/project/factory.ts` becomes:

```ts
export { freshProject, freshTrack, freshStep } from '@fiddle/shared';
```

`packages/client/src/project/index.ts` (the public barrel) does **not** need to change — it already re-exports from `./types` and `./factory`.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 183 tests pass. Type-check clean.

```bash
git add -A
git commit -m "refactor(shared): move Project types + freshProject to @fiddle/shared"
git checkout feature/ws-sync-protocol
git merge --no-ff task/02-shared-project-types
```

---

## Task 3: Add Zod schema for `Project` + path accept-list

**Scope:** Add `zod` as a dependency of `@fiddle/shared` (it must compile in both browser and Node). Define a Zod schema that mirrors `Project`. Define the path accept-list as a typed structure plus a `validatePath(path, value)` function that walks the schema.

**Files:**
- Modify: `packages/shared/package.json` (add `zod` dep)
- Create: `packages/shared/src/project/schema.ts`
- Create: `packages/shared/src/project/schema.test.ts`
- Create: `packages/shared/src/project/accept-list.ts`
- Create: `packages/shared/src/project/accept-list.test.ts`
- Modify: `packages/shared/src/project/index.ts`

- [ ] **Step 1: Add `zod` to shared**

```bash
npm install zod -w @fiddle/shared
```

Confirm `packages/shared/package.json` now has `"zod": "^3.x"` under `dependencies`.

- [ ] **Step 2: Add a Vitest setup to `@fiddle/shared`**

`@fiddle/shared` doesn't have a test runner yet. Add one:

In `packages/shared/package.json`:

```json
"scripts": {
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
},
"devDependencies": {
  "vitest": "^4.1.7",
  "typescript": "^5.4.0"
}
```

`packages/shared/tsconfig.json` (create if absent):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

Run `npm install` from the repo root to get vitest installed.

- [ ] **Step 3: Write the Zod schema**

`packages/shared/src/project/schema.ts`:

```ts
import { z } from 'zod';

const ADSR = z.object({
  attack: z.number().min(0).max(10),
  decay: z.number().min(0).max(10),
  sustain: z.number().min(0).max(1),
  release: z.number().min(0).max(10),
});

const SynthParams = z.object({
  mode: z.enum(['mono', 'poly']),
  osc1Type: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  osc1Level: z.number().min(0).max(1),
  osc1Coarse: z.number().int().min(-24).max(24),
  osc1Fine: z.number().min(-100).max(100),
  osc2Type: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  osc2Level: z.number().min(0).max(1),
  osc2Coarse: z.number().int().min(-24).max(24),
  osc2Fine: z.number().min(-100).max(100),
  filterCutoff: z.number().min(20).max(20000),
  filterResonance: z.number().min(0).max(40),
  filterEnvAmount: z.number().min(-4).max(4),
  filterEnv: ADSR,
  ampEnv: ADSR,
});

// Define KickParams, HatParams, SnareParams, ClapParams similarly
// using the param-range knowledge from each engine's existing setter clamps.

const Step = z.object({
  note: z.string(),                 // tighten with z.enum if note set is fixed
  octave: z.number().int().min(0).max(8),
  length: z.number().int().min(1).max(16),
  velocity: z.number().min(0).max(1),
  mute: z.boolean(),
  chordType: z.string(),            // tighten with z.enum if chord set is fixed
});

const Mixer = z.object({
  volume: z.number().min(0).max(1.5),
  muted: z.boolean(),
  soloed: z.boolean(),
});

const Track = z.object({
  engineType: z.enum(['synth', 'kick', 'hat', 'snare', 'clap']),
  engines: z.object({
    synth: SynthParams,
    kick:  /* KickParams */,
    hat:   /* HatParams */,
    snare: /* SnareParams */,
    clap:  /* ClapParams */,
  }),
  mixer: Mixer,
  steps: z.array(Step).length(16),
});

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),       // bump when PROJECT_SCHEMA_VERSION bumps
  bpm: z.number().int().min(40).max(240),
  tracks: z.array(Track).length(4),
});

// Re-export sub-schemas for path validation
export const Schemas = {
  ADSR, SynthParams, /* Kick…Clap */, Step, Mixer, Track, Project: ProjectSchema,
} as const;
```

**Range derivation:** for each engine param, look up the existing setter in `packages/client/src/engine/*Engine.ts` and find the `clamp(…)` / `Math.max/min` call. The min/max in the Zod schema must match the engine's accepted range. If the engine doesn't clamp, infer a reasonable range and document the choice in a `// range:` comment.

- [ ] **Step 4: Schema test**

`packages/shared/src/project/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ProjectSchema } from './schema.js';
import { freshProject } from './factory.js';

describe('ProjectSchema', () => {
  it('accepts a freshProject', () => {
    expect(() => ProjectSchema.parse(freshProject())).not.toThrow();
  });

  it('rejects bpm out of range', () => {
    const p = freshProject();
    p.bpm = 9999;
    expect(() => ProjectSchema.parse(p)).toThrow();
  });

  it('rejects wrong number of tracks', () => {
    const p = freshProject();
    p.tracks = p.tracks.slice(0, 2);
    expect(() => ProjectSchema.parse(p)).toThrow();
  });

  it('rejects unknown engineType', () => {
    const p = freshProject();
    (p.tracks[0] as any).engineType = 'flute';
    expect(() => ProjectSchema.parse(p)).toThrow();
  });
});
```

Run: `npm test -w @fiddle/shared`. Expected: 4/4 pass.

- [ ] **Step 5: Write the accept-list + path-walk validator**

`packages/shared/src/project/accept-list.ts`:

```ts
import { z } from 'zod';
import { Schemas } from './schema.js';

export type PathSeg = string | number;
export type Path = PathSeg[];

// Accept-list of writable path *prefixes*. Wildcards: a segment of the
// literal string '*' matches any single segment of the appropriate type.
// Patterns are checked top-to-bottom; first match wins.
const PATTERNS: readonly Path[] = [
  ['bpm'],
  ['tracks', '*', 'engineType'],
  ['tracks', '*', 'engines', 'synth', '*'],
  ['tracks', '*', 'engines', 'kick',  '*'],
  ['tracks', '*', 'engines', 'hat',   '*'],
  ['tracks', '*', 'engines', 'snare', '*'],
  ['tracks', '*', 'engines', 'clap',  '*'],
  // Nested envelope objects under engine params (filterEnv.attack, etc.):
  ['tracks', '*', 'engines', 'synth', '*', '*'],
  ['tracks', '*', 'steps',   '*', 'note'],
  ['tracks', '*', 'steps',   '*', 'octave'],
  ['tracks', '*', 'steps',   '*', 'length'],
  ['tracks', '*', 'steps',   '*', 'velocity'],
  ['tracks', '*', 'steps',   '*', 'mute'],
  ['tracks', '*', 'steps',   '*', 'chordType'],
  ['tracks', '*', 'mixer',   'volume'],
  ['tracks', '*', 'mixer',   'muted'],
  ['tracks', '*', 'mixer',   'soloed'],
];

function pathMatchesPattern(path: Path, pattern: Path): boolean {
  if (path.length !== pattern.length) return false;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    const pat = pattern[i];
    if (pat === '*') continue;
    if (pat !== seg) return false;
  }
  return true;
}

export function pathIsWritable(path: Path): boolean {
  return PATTERNS.some(p => pathMatchesPattern(path, p));
}

// Walk Project's Zod schema by the path and return the leaf Zod schema,
// or null if the path doesn't resolve. Used to validate the op's `value`.
export function resolveLeafSchema(path: Path): z.ZodTypeAny | null {
  let cursor: z.ZodTypeAny = Schemas.Project;
  for (const seg of path) {
    if (cursor instanceof z.ZodObject) {
      const shape = cursor.shape as Record<string, z.ZodTypeAny>;
      if (!(seg in shape)) return null;
      cursor = shape[seg as string];
    } else if (cursor instanceof z.ZodArray) {
      if (typeof seg !== 'number') return null;
      cursor = cursor.element;
    } else {
      return null;
    }
  }
  return cursor;
}

export type ValidatePathResult =
  | { ok: true }
  | { ok: false; code: 'path.invalid' | 'value.invalid'; message: string };

export function validatePathAndValue(path: Path, value: unknown): ValidatePathResult {
  if (!pathIsWritable(path)) {
    return { ok: false, code: 'path.invalid', message: `path ${path.join('.')} is not client-writable` };
  }
  const leaf = resolveLeafSchema(path);
  if (!leaf) {
    return { ok: false, code: 'path.invalid', message: `path ${path.join('.')} does not exist in Project schema` };
  }
  const parsed = leaf.safeParse(value);
  if (!parsed.success) {
    return { ok: false, code: 'value.invalid', message: parsed.error.issues.map(i => i.message).join('; ') };
  }
  return { ok: true };
}
```

- [ ] **Step 6: Accept-list test**

`packages/shared/src/project/accept-list.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validatePathAndValue, pathIsWritable } from './accept-list.js';

describe('accept-list', () => {
  it('allows bpm writes', () => {
    expect(validatePathAndValue(['bpm'], 120)).toEqual({ ok: true });
  });

  it('rejects bpm out of range', () => {
    const r = validatePathAndValue(['bpm'], 9999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value.invalid');
  });

  it('allows synth filterCutoff', () => {
    expect(validatePathAndValue(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 800)).toEqual({ ok: true });
  });

  it('allows nested filterEnv.attack', () => {
    expect(validatePathAndValue(['tracks', 0, 'engines', 'synth', 'filterEnv', 'attack'], 0.1)).toEqual({ ok: true });
  });

  it('allows step velocity', () => {
    expect(validatePathAndValue(['tracks', 1, 'steps', 4, 'velocity'], 0.8)).toEqual({ ok: true });
  });

  it('rejects schemaVersion writes', () => {
    const r = validatePathAndValue(['schemaVersion'], 99);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('path.invalid');
  });

  it('rejects unknown engine type', () => {
    const r = validatePathAndValue(['tracks', 0, 'engineType'], 'flute');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value.invalid');
  });

  it('rejects out-of-bounds track index', () => {
    // Note: pathIsWritable accepts any number for *; the leaf schema
    // doesn't catch this. Document this gap in a comment — server-side
    // ConnectionHandler will additionally bound-check track/step indices.
    expect(pathIsWritable(['tracks', 99, 'engineType'])).toBe(true);
  });
});
```

Run: `npm test -w @fiddle/shared`. Expected: 8 + 4 = 12 passing.

- [ ] **Step 7: Wire into the barrel**

`packages/shared/src/project/index.ts`:

```ts
export * from './types.js';
export * from './factory.js';
export * from './schema.js';
export * from './accept-list.js';
```

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 183 + 12 = 195 tests pass.

```bash
git add -A
git commit -m "feat(shared): add Zod schema + writable path accept-list for Project"
git checkout feature/ws-sync-protocol
git merge --no-ff task/03-shared-zod-schema
```

---

## Task 4: Add protocol message types + Zod schemas + version constants in `@fiddle/shared`

**Scope:** Define every wire message type from the spec as TypeScript types and Zod schemas. Add `PROTOCOL_VERSION`, the color palette, and the handles list. Nothing in this task touches the server or client integration yet — just the typed surface.

**Files:**
- Create: `packages/shared/src/protocol/types.ts`
- Create: `packages/shared/src/protocol/schema.ts`
- Create: `packages/shared/src/protocol/schema.test.ts`
- Create: `packages/shared/src/protocol/identity.ts`
- Create: `packages/shared/src/protocol/version.ts`
- Create: `packages/shared/src/protocol/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Version constants**

`packages/shared/src/protocol/version.ts`:

```ts
export const PROTOCOL_VERSION = 1 as const;
```

- [ ] **Step 2: Identity constants**

`packages/shared/src/protocol/identity.ts`:

```ts
// Tier B presence palette (8 distinct hues; max 8 simultaneous users in a room).
export const PALETTE = [
  '#FF4136', '#FF851B', '#FFDC00', '#2ECC40',
  '#39CCCC', '#0074D9', '#B10DC9', '#F012BE',
] as const;
export type PaletteColor = typeof PALETTE[number];

// Short, friendly animal handles. Server picks the first not in use in a room.
export const HANDLES = [
  'Owl', 'Fox', 'Otter', 'Lynx', 'Hawk', 'Mole',
  'Frog', 'Wren', 'Toad', 'Bat',  'Ibis', 'Kit',
  'Stoat','Crane','Raven','Newt', 'Marten','Vole',
  'Jay',  'Heron',
] as const;
export type Handle = typeof HANDLES[number];
```

- [ ] **Step 3: Message types**

`packages/shared/src/protocol/types.ts`:

```ts
import type { Project } from '../project/types.js';
import type { Path } from '../project/accept-list.js';
import type { PaletteColor, Handle } from './identity.js';

export interface Identity {
  clientId: string;
  color: PaletteColor;
  handle: Handle;
}

// === Client → Server ===

export interface HelloMessage {
  v: 1;
  type: 'hello';
  schemaVersion: number;
  clientId?: string;       // present on resume
  resumeFromOpId?: number; // present on resume
}

export interface SetOpClient {
  v: 1;
  type: 'set';
  clientSeq: number;
  path: Path;
  value: unknown;
}

export interface PongMessage {
  v: 1;
  type: 'pong';
}

export type ClientMessage = HelloMessage | SetOpClient | PongMessage;

// === Server → Client ===

export interface WelcomeMessage {
  v: 1;
  type: 'welcome';
  clientId: string;
  color: PaletteColor;
  handle: Handle;
  opIdHead: number;
  schemaVersion: number;
  roster: Identity[];
}

export interface SnapshotMessage {
  v: 1;
  type: 'snapshot';
  opId: number;
  project: Project;
}

export interface SetOpBroadcast {
  v: 1;
  type: 'set';
  opId: number;
  clientId: string;
  clientSeq?: number;     // present only on echo to originator
  path: Path;
  value: unknown;
}

export interface SyncCompleteMessage {
  v: 1;
  type: 'sync.complete';
  opId: number;
}

export type NackCode =
  | 'path.invalid'
  | 'value.invalid'
  | 'rate.limited'
  | 'op.duplicate';

export interface NackMessage {
  v: 1;
  type: 'nack';
  clientSeq: number;
  code: NackCode;
  message: string;
  details?: unknown;
}

export type ErrorCode =
  | 'schema.version_mismatch'
  | 'protocol.version_mismatch'
  | 'hello.invalid'
  | 'room.full'
  | 'resume.unknown_client'
  | 'resume.client_ahead'
  | 'overloaded'
  | 'internal';

export interface ErrorMessage {
  v: 1;
  type: 'error';
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

export interface PresenceUpdateMessage {
  v: 1;
  type: 'presence.update';
  roster: Identity[];
}

export interface PingMessage {
  v: 1;
  type: 'ping';
}

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | SetOpBroadcast
  | SyncCompleteMessage
  | NackMessage
  | ErrorMessage
  | PresenceUpdateMessage
  | PingMessage;
```

- [ ] **Step 4: Zod schemas for inbound (client → server) messages**

`packages/shared/src/protocol/schema.ts`:

```ts
import { z } from 'zod';

const VersionEnvelope = z.object({ v: z.literal(1) });

export const HelloSchema = VersionEnvelope.extend({
  type: z.literal('hello'),
  schemaVersion: z.number().int(),
  clientId: z.string().optional(),
  resumeFromOpId: z.number().int().nonnegative().optional(),
});

export const SetOpClientSchema = VersionEnvelope.extend({
  type: z.literal('set'),
  clientSeq: z.number().int().nonnegative(),
  path: z.array(z.union([z.string(), z.number().int()])),
  value: z.unknown(),
});

export const PongSchema = VersionEnvelope.extend({
  type: z.literal('pong'),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  SetOpClientSchema,
  PongSchema,
]);
```

(No need to schema-validate server → client messages — they're constructed by the server itself and the type system enforces shape.)

- [ ] **Step 5: Test the schema**

`packages/shared/src/protocol/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ClientMessageSchema } from './schema.js';

describe('ClientMessageSchema', () => {
  it('accepts a fresh hello', () => {
    expect(ClientMessageSchema.safeParse({ v: 1, type: 'hello', schemaVersion: 1 }).success).toBe(true);
  });

  it('accepts a resume hello', () => {
    const r = ClientMessageSchema.safeParse({
      v: 1, type: 'hello', schemaVersion: 1, clientId: 'c_a3f9', resumeFromOpId: 42,
    });
    expect(r.success).toBe(true);
  });

  it('rejects hello with wrong v', () => {
    expect(ClientMessageSchema.safeParse({ v: 2, type: 'hello', schemaVersion: 1 }).success).toBe(false);
  });

  it('accepts a set op', () => {
    expect(ClientMessageSchema.safeParse({
      v: 1, type: 'set', clientSeq: 17, path: ['bpm'], value: 120,
    }).success).toBe(true);
  });

  it('rejects set op with negative clientSeq', () => {
    expect(ClientMessageSchema.safeParse({
      v: 1, type: 'set', clientSeq: -1, path: ['bpm'], value: 120,
    }).success).toBe(false);
  });

  it('accepts pong', () => {
    expect(ClientMessageSchema.safeParse({ v: 1, type: 'pong' }).success).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(ClientMessageSchema.safeParse({ v: 1, type: 'gibberish' }).success).toBe(false);
  });
});
```

- [ ] **Step 6: Barrel + top-level export**

`packages/shared/src/protocol/index.ts`:

```ts
export * from './types.js';
export * from './schema.js';
export * from './identity.js';
export * from './version.js';
```

Modify `packages/shared/src/index.ts`:

```ts
export * from './engines/index.js';
export * from './project/index.js';
export * from './protocol/index.js';
// (existing exports stay)
```

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 195 + 7 = 202 tests pass.

```bash
git add -A
git commit -m "feat(shared): add WS protocol types + Zod schemas + identity constants"
git checkout feature/ws-sync-protocol
git merge --no-ff task/04-shared-protocol-types
```

---

## Task 5: Server — `RoomStore` interface + `InMemoryRoomStore`

**Scope:** The protocol's authoritative state lives behind the `RoomStore` interface. Phase 1 implementation is a single-process in-memory `Map` with a ring buffer per room. All room mutation goes through this interface — no direct `Map.get(roomId)` calls anywhere else in the server code.

**Files:**
- Create: `packages/server/src/room/types.ts`
- Create: `packages/server/src/room/RoomStore.ts`
- Create: `packages/server/src/room/InMemoryRoomStore.ts`
- Create: `packages/server/src/room/InMemoryRoomStore.test.ts`

- [ ] **Step 1: Internal types**

`packages/server/src/room/types.ts`:

```ts
import type { Project, Identity, Path } from '@fiddle/shared';

export interface AppliedOp {
  opId: number;
  clientId: string;
  clientSeq: number;
  path: Path;
  value: unknown;
}

export interface RoomState {
  roomId: string;
  project: Project;
  opLog: AppliedOp[];        // ring buffer; max length 1000
  nextOpId: number;
  identities: Map<string, Identity>;  // clientId → Identity, kept past disconnect (within grace)
  graceTimer: NodeJS.Timeout | null;  // active when room has 0 sockets
}
```

- [ ] **Step 2: Interface**

`packages/server/src/room/RoomStore.ts`:

```ts
import type { Project, Identity, Path } from '@fiddle/shared';
import type { AppliedOp } from './types.js';

export interface AppendOpInput {
  clientId: string;
  clientSeq: number;
  path: Path;
  value: unknown;
}

export interface AppendOpResult {
  // The op was appended; subscribers should be told via broadcast.
  ok: true;
  op: AppliedOp;
} | {
  // (clientId, clientSeq) already present in the ring buffer. Server
  // should nack with code:"op.duplicate".
  ok: false;
  reason: 'duplicate';
};

export interface RoomStore {
  getOrCreate(roomId: string, freshProject: () => Project): Promise<{ project: Project; opIdHead: number }>;

  // Append an op to the room's log. Returns assigned opId, or null on duplicate.
  appendOp(roomId: string, input: AppendOpInput): Promise<AppendOpResult>;

  // Fetch ops in (fromOpId .. opIdHead]. Returns null if fromOpId is
  // older than the ring buffer's oldest retained op (snapshot fallback).
  getOpsSince(roomId: string, fromOpId: number): Promise<AppliedOp[] | null>;

  // Identity bookkeeping.
  setIdentity(roomId: string, identity: Identity): Promise<void>;
  getIdentity(roomId: string, clientId: string): Promise<Identity | null>;
  listIdentities(roomId: string): Promise<Identity[]>;
  removeIdentity(roomId: string, clientId: string): Promise<void>;

  // Lifecycle.
  startGrace(roomId: string, onElapsed: () => void): Promise<void>;
  cancelGrace(roomId: string): Promise<void>;
  pruneRoom(roomId: string): Promise<void>;
}

export const RING_BUFFER_CAPACITY = 1000;
export const GRACE_MS = 5 * 60 * 1000;
```

- [ ] **Step 3: In-memory implementation**

`packages/server/src/room/InMemoryRoomStore.ts`:

```ts
import type { Project, Identity, Path } from '@fiddle/shared';
import {
  RoomStore,
  AppendOpInput,
  AppendOpResult,
  RING_BUFFER_CAPACITY,
  GRACE_MS,
} from './RoomStore.js';
import type { AppliedOp, RoomState } from './types.js';

export class InMemoryRoomStore implements RoomStore {
  private rooms = new Map<string, RoomState>();

  async getOrCreate(
    roomId: string,
    freshProject: () => Project,
  ): Promise<{ project: Project; opIdHead: number }> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        project: freshProject(),
        opLog: [],
        nextOpId: 1,
        identities: new Map(),
        graceTimer: null,
      };
      this.rooms.set(roomId, room);
    }
    const opIdHead = room.nextOpId - 1;
    return { project: room.project, opIdHead };
  }

  async appendOp(roomId: string, input: AppendOpInput): Promise<AppendOpResult> {
    const room = this.requireRoom(roomId);

    // Dedup by (clientId, clientSeq) across the ring buffer.
    const dup = room.opLog.find(
      o => o.clientId === input.clientId && o.clientSeq === input.clientSeq,
    );
    if (dup) return { ok: false, reason: 'duplicate' };

    const op: AppliedOp = {
      opId: room.nextOpId,
      clientId: input.clientId,
      clientSeq: input.clientSeq,
      path: input.path,
      value: input.value,
    };

    // Apply to project snapshot.
    setDeep(room.project, input.path, input.value);

    // Append + trim ring.
    room.opLog.push(op);
    if (room.opLog.length > RING_BUFFER_CAPACITY) {
      room.opLog.shift();
    }
    room.nextOpId += 1;

    return { ok: true, op };
  }

  async getOpsSince(roomId: string, fromOpId: number): Promise<AppliedOp[] | null> {
    const room = this.requireRoom(roomId);
    if (room.opLog.length === 0) {
      // Empty log; either room is fresh or fromOpId equals current head.
      return room.nextOpId - 1 === fromOpId ? [] : null;
    }
    const oldest = room.opLog[0].opId;
    if (fromOpId + 1 < oldest) return null; // ring rotated past the requested point
    return room.opLog.filter(o => o.opId > fromOpId);
  }

  async setIdentity(roomId: string, identity: Identity): Promise<void> {
    this.requireRoom(roomId).identities.set(identity.clientId, identity);
  }
  async getIdentity(roomId: string, clientId: string): Promise<Identity | null> {
    return this.requireRoom(roomId).identities.get(clientId) ?? null;
  }
  async listIdentities(roomId: string): Promise<Identity[]> {
    return [...this.requireRoom(roomId).identities.values()];
  }
  async removeIdentity(roomId: string, clientId: string): Promise<void> {
    this.requireRoom(roomId).identities.delete(clientId);
  }

  async startGrace(roomId: string, onElapsed: () => void): Promise<void> {
    const room = this.requireRoom(roomId);
    if (room.graceTimer) clearTimeout(room.graceTimer);
    room.graceTimer = setTimeout(onElapsed, GRACE_MS);
  }
  async cancelGrace(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room?.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
  }
  async pruneRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room?.graceTimer) clearTimeout(room.graceTimer);
    this.rooms.delete(roomId);
  }

  private requireRoom(roomId: string): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);
    return room;
  }
}

function setDeep(obj: any, path: (string | number)[], value: unknown): void {
  if (path.length === 0) return;
  let cursor = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]];
    if (cursor == null) throw new Error(`Path break at segment ${i}`);
  }
  cursor[path[path.length - 1]] = value;
}
```

- [ ] **Step 4: Tests**

`packages/server/src/room/InMemoryRoomStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { InMemoryRoomStore } from './InMemoryRoomStore.js';

describe('InMemoryRoomStore', () => {
  let store: InMemoryRoomStore;
  beforeEach(() => { store = new InMemoryRoomStore(); });

  it('getOrCreate creates a fresh room with opIdHead=0', async () => {
    const { project, opIdHead } = await store.getOrCreate('r1', freshProject);
    expect(opIdHead).toBe(0);
    expect(project.bpm).toBe(120);
    expect(project.tracks).toHaveLength(4);
  });

  it('appendOp assigns sequential opIds and mutates project', async () => {
    await store.getOrCreate('r1', freshProject);
    const r1 = await store.appendOp('r1', { clientId:'c1', clientSeq:1, path:['bpm'], value:140 });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.op.opId).toBe(1);

    const r2 = await store.appendOp('r1', { clientId:'c1', clientSeq:2, path:['bpm'], value:150 });
    if (r2.ok) expect(r2.op.opId).toBe(2);
  });

  it('detects duplicate (clientId, clientSeq)', async () => {
    await store.getOrCreate('r1', freshProject);
    await store.appendOp('r1', { clientId:'c1', clientSeq:1, path:['bpm'], value:140 });
    const dup = await store.appendOp('r1', { clientId:'c1', clientSeq:1, path:['bpm'], value:999 });
    expect(dup).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('getOpsSince returns ops after fromOpId', async () => {
    await store.getOrCreate('r1', freshProject);
    await store.appendOp('r1', { clientId:'c1', clientSeq:1, path:['bpm'], value:140 });
    await store.appendOp('r1', { clientId:'c1', clientSeq:2, path:['bpm'], value:150 });
    const ops = await store.getOpsSince('r1', 0);
    expect(ops).toHaveLength(2);
  });

  it('getOpsSince returns null when fromOpId is older than ring buffer', async () => {
    await store.getOrCreate('r1', freshProject);
    // Append 1001 ops to evict the oldest.
    for (let i = 1; i <= 1001; i++) {
      await store.appendOp('r1', { clientId:'c1', clientSeq:i, path:['bpm'], value: 40 + (i % 200) });
    }
    expect(await store.getOpsSince('r1', 0)).toBeNull(); // op 1 is gone
    const recent = await store.getOpsSince('r1', 1000);
    expect(recent).toEqual(expect.any(Array));
    expect((recent ?? []).length).toBe(1);
  });

  it('identity bookkeeping round-trip', async () => {
    await store.getOrCreate('r1', freshProject);
    await store.setIdentity('r1', { clientId:'c1', color:'#FF4136', handle:'Owl' });
    expect(await store.getIdentity('r1', 'c1')).toEqual({ clientId:'c1', color:'#FF4136', handle:'Owl' });
    expect(await store.listIdentities('r1')).toHaveLength(1);
    await store.removeIdentity('r1', 'c1');
    expect(await store.listIdentities('r1')).toHaveLength(0);
  });

  it('pruneRoom removes the room', async () => {
    await store.getOrCreate('r1', freshProject);
    await store.pruneRoom('r1');
    await expect(store.appendOp('r1', { clientId:'c1', clientSeq:1, path:['bpm'], value:140 }))
      .rejects.toThrow(/not found/);
  });
});
```

Run: `npm test -w @fiddle/server`. Expected: 7 passing.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 202 + 7 = 209 tests pass (server goes from 1 → 8).

```bash
git add -A
git commit -m "feat(server): RoomStore interface + InMemoryRoomStore with ring buffer"
git checkout feature/ws-sync-protocol
git merge --no-ff task/05-server-room-store
```

---

## Task 6: Server — identity assignment (color + handle picker)

**Scope:** Pure function `assignIdentity(takenColors, takenHandles)` that returns a fresh `Identity` using the palette and handles from shared.

**Files:**
- Create: `packages/server/src/room/identity.ts`
- Create: `packages/server/src/room/identity.test.ts`

- [ ] **Step 1: Implementation**

`packages/server/src/room/identity.ts`:

```ts
import { PALETTE, HANDLES, type Identity, type PaletteColor, type Handle } from '@fiddle/shared';

export function assignColor(taken: ReadonlySet<string>): PaletteColor {
  for (const c of PALETTE) if (!taken.has(c)) return c;
  // All taken (impossible at cap=4 but defensive): hash-pick.
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

export function assignHandle(taken: ReadonlySet<string>): Handle | string {
  for (const h of HANDLES) if (!taken.has(h)) return h;
  // All taken: append digit until unique.
  for (let n = 2; n < 999; n++) {
    for (const h of HANDLES) {
      const candidate = `${h}${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  // Practical absurdity guard: 20 * 998 = ~20k unique handles.
  return `User_${Date.now()}`;
}

export function generateClientId(): string {
  // 9 chars of base32 — collision-resistant within a room of <= 4 clients.
  const chars = '0123456789abcdefghjkmnpqrstvwxyz'; // crockford base32
  let s = 'c_';
  for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function makeIdentity(existing: readonly Identity[]): Identity {
  const takenColors = new Set(existing.map(e => e.color));
  const takenHandles = new Set(existing.map(e => e.handle));
  return {
    clientId: generateClientId(),
    color: assignColor(takenColors),
    handle: assignHandle(takenHandles) as Handle,
  };
}
```

- [ ] **Step 2: Tests**

`packages/server/src/room/identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PALETTE, HANDLES } from '@fiddle/shared';
import { makeIdentity, assignColor, assignHandle, generateClientId } from './identity.js';

describe('identity', () => {
  it('assignColor picks the first unused', () => {
    expect(assignColor(new Set())).toBe(PALETTE[0]);
    expect(assignColor(new Set([PALETTE[0]]))).toBe(PALETTE[1]);
  });

  it('assignHandle picks the first unused', () => {
    expect(assignHandle(new Set())).toBe(HANDLES[0]);
    expect(assignHandle(new Set([HANDLES[0]]))).toBe(HANDLES[1]);
  });

  it('assignHandle wraps with digit suffix when all taken', () => {
    const allTaken = new Set(HANDLES);
    const got = assignHandle(allTaken);
    expect(got).toMatch(/[A-Za-z]+2$/);
  });

  it('generateClientId is reasonably unique', () => {
    const ids = new Set(Array.from({ length: 100 }, generateClientId));
    expect(ids.size).toBe(100); // no collisions in 100 draws
  });

  it('makeIdentity avoids collisions with existing', () => {
    const existing = [
      { clientId: 'c_1', color: PALETTE[0], handle: HANDLES[0] },
      { clientId: 'c_2', color: PALETTE[1], handle: HANDLES[1] },
    ];
    const next = makeIdentity(existing as any);
    expect(next.color).toBe(PALETTE[2]);
    expect(next.handle).toBe(HANDLES[2]);
  });
});
```

Run: expected 5/5 passing.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 209 + 5 = 214 tests pass.

```bash
git add -A
git commit -m "feat(server): identity assignment (color + handle + clientId)"
git checkout feature/ws-sync-protocol
git merge --no-ff task/06-server-identity
```

---

## Task 7: Server — `ConnectionHandler` (hello → welcome → snapshot or replay → sync.complete)

**Scope:** The first half of the WS lifecycle, abstracted from Fastify route plumbing so it can be unit-tested with mock sockets. Validates the `hello`, issues clientId/color/handle, sends `welcome`, sends `snapshot` (fresh join) or replay ops (resume), then `sync.complete`. Broadcasts `presence.update` to the rest of the room.

**Files:**
- Create: `packages/server/src/sync/ConnectionHandler.ts`
- Create: `packages/server/src/sync/ConnectionHandler.test.ts`
- Create: `packages/server/src/sync/SocketLike.ts` (interface so tests can inject a mock)

- [ ] **Step 1: `SocketLike` interface**

`packages/server/src/sync/SocketLike.ts`:

```ts
import type { ServerMessage } from '@fiddle/shared';

export interface SocketLike {
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number; // 1 = OPEN
}

export interface RoomConnectionPool {
  // Returns all currently-open sockets for the room *other than* `exclude`.
  others(roomId: string, exclude: SocketLike): SocketLike[];
  // Returns all sockets in the room.
  all(roomId: string): SocketLike[];
  // Count of open sockets in the room.
  size(roomId: string): number;
}
```

- [ ] **Step 2: `ConnectionHandler` skeleton**

`packages/server/src/sync/ConnectionHandler.ts`:

```ts
import {
  ClientMessageSchema, freshProject, PROTOCOL_VERSION, PROJECT_SCHEMA_VERSION,
  type ClientMessage, type WelcomeMessage, type ErrorMessage,
  type PresenceUpdateMessage, type SnapshotMessage, type SetOpBroadcast,
  type SyncCompleteMessage, type Identity,
} from '@fiddle/shared';
import type { RoomStore } from '../room/RoomStore.js';
import { makeIdentity } from '../room/identity.js';
import type { SocketLike, RoomConnectionPool } from './SocketLike.js';

const ROOM_CAP = 4;

export class ConnectionHandler {
  private clientId: string | null = null;
  private identity: Identity | null = null;
  private helloProcessed = false;

  constructor(
    private readonly roomId: string,
    private readonly socket: SocketLike,
    private readonly store: RoomStore,
    private readonly pool: RoomConnectionPool,
    private readonly log: (msg: string, fields?: object) => void,
  ) {}

  // Entry point: dispatch a parsed message.
  async onMessage(raw: unknown): Promise<void> {
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.fatal('hello.invalid', 'unparseable message: ' + parsed.error.message);
      return;
    }
    const msg = parsed.data;

    if (msg.type === 'hello') {
      if (this.helloProcessed) {
        this.fatal('hello.invalid', 'duplicate hello');
        return;
      }
      await this.handleHello(msg);
      return;
    }

    if (!this.helloProcessed) {
      this.fatal('hello.invalid', 'first message must be hello');
      return;
    }

    if (msg.type === 'pong') {
      // Pong tracking handled by heartbeat module (Task 11).
      return;
    }

    if (msg.type === 'set') {
      // Op handling — Task 8. Stub for now:
      this.log('set op received (handler TBD in Task 8)', { clientSeq: msg.clientSeq });
      return;
    }
  }

  async onClose(): Promise<void> {
    if (!this.clientId) return;
    // Removed-from-pool happens at the Fastify route layer; this handler
    // just broadcasts presence + starts grace if room is now empty.
    if (this.pool.size(this.roomId) === 0) {
      await this.store.startGrace(this.roomId, () => {
        void this.store.pruneRoom(this.roomId);
        this.log('room pruned after grace', { roomId: this.roomId });
      });
    } else {
      const roster = await this.store.listIdentities(this.roomId);
      const presence: PresenceUpdateMessage = { v:1, type:'presence.update', roster };
      for (const s of this.pool.others(this.roomId, this.socket)) s.send(presence);
    }
  }

  private async handleHello(msg: { schemaVersion: number; clientId?: string; resumeFromOpId?: number }): Promise<void> {
    // Schema/protocol version check.
    if (msg.schemaVersion !== PROJECT_SCHEMA_VERSION) {
      this.fatal('schema.version_mismatch',
        `server schema v${PROJECT_SCHEMA_VERSION}, client sent v${msg.schemaVersion}`);
      return;
    }

    // Room cap check. (Counts the soon-to-be-added socket: pool.size already
    // includes this socket if the route layer pushes before dispatch.)
    if (this.pool.size(this.roomId) > ROOM_CAP) {
      this.fatal('room.full', `room at capacity (${ROOM_CAP})`);
      return;
    }

    // Get-or-create room.
    const { opIdHead } = await this.store.getOrCreate(this.roomId, freshProject);
    await this.store.cancelGrace(this.roomId);

    // Resolve identity.
    let identity: Identity | null = null;
    let resumeIdentityWarning: 'unknown_client' | null = null;
    if (msg.clientId) {
      identity = await this.store.getIdentity(this.roomId, msg.clientId);
      if (!identity) resumeIdentityWarning = 'unknown_client';
    }
    if (!identity) {
      const roster = await this.store.listIdentities(this.roomId);
      identity = makeIdentity(roster);
      await this.store.setIdentity(this.roomId, identity);
    }

    this.clientId = identity.clientId;
    this.identity = identity;
    this.helloProcessed = true;

    // Welcome.
    const roster = await this.store.listIdentities(this.roomId);
    const welcome: WelcomeMessage = {
      v: 1,
      type: 'welcome',
      clientId: identity.clientId,
      color: identity.color,
      handle: identity.handle,
      opIdHead,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      roster,
    };
    this.socket.send(welcome);

    if (resumeIdentityWarning) {
      const e: ErrorMessage = { v:1, type:'error', code:'resume.unknown_client',
        message:'client ID not recognized; reissued fresh identity', fatal:false };
      this.socket.send(e);
    }

    // Catch-up: snapshot or replay.
    const resumeFrom = msg.resumeFromOpId ?? -1;
    if (resumeFrom >= 0 && resumeFrom <= opIdHead) {
      const ops = await this.store.getOpsSince(this.roomId, resumeFrom);
      if (ops === null) {
        // Gap too big — snapshot fallback.
        await this.sendSnapshot(opIdHead);
      } else {
        // Replay.
        for (const op of ops) {
          const broadcast: SetOpBroadcast = {
            v:1, type:'set', opId:op.opId, clientId:op.clientId,
            // Don't echo clientSeq during catch-up replay — the originator
            // is reconnecting from scratch, no outbox correlation to do.
            path: op.path, value: op.value,
          };
          this.socket.send(broadcast);
        }
      }
    } else if (resumeFrom > opIdHead) {
      // Client claims to be ahead of server — defensive snapshot.
      const e: ErrorMessage = { v:1, type:'error', code:'resume.client_ahead',
        message:'client opId ahead of server; sending fresh snapshot', fatal:false };
      this.socket.send(e);
      await this.sendSnapshot(opIdHead);
    } else {
      // Fresh join.
      await this.sendSnapshot(opIdHead);
    }

    const done: SyncCompleteMessage = { v:1, type:'sync.complete', opId: opIdHead };
    this.socket.send(done);

    // Broadcast new roster to *other* clients (welcome already gave it to us).
    const presence: PresenceUpdateMessage = { v:1, type:'presence.update', roster };
    for (const s of this.pool.others(this.roomId, this.socket)) s.send(presence);

    this.log('client live', { roomId: this.roomId, clientId: this.clientId });
  }

  private async sendSnapshot(opIdHead: number): Promise<void> {
    const { project } = await this.store.getOrCreate(this.roomId, freshProject);
    const snap: SnapshotMessage = { v:1, type:'snapshot', opId: opIdHead, project };
    this.socket.send(snap);
  }

  private fatal(code: ErrorMessage['code'], message: string): void {
    const e: ErrorMessage = { v:1, type:'error', code, message, fatal:true };
    this.socket.send(e);
    this.socket.close(1008, code);
  }
}
```

- [ ] **Step 3: Tests**

`packages/server/src/sync/ConnectionHandler.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { freshProject, PROJECT_SCHEMA_VERSION } from '@fiddle/shared';
import { InMemoryRoomStore } from '../room/InMemoryRoomStore.js';
import { ConnectionHandler } from './ConnectionHandler.js';
import type { SocketLike, RoomConnectionPool } from './SocketLike.js';
import type { ServerMessage } from '@fiddle/shared';

function makeMockSocket(): SocketLike & { sent: ServerMessage[]; closed: boolean } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    closed: false,
    readyState: 1,
    send(m) { sent.push(m); },
    close() { this.closed = true; this.readyState = 3; },
  };
}

class FakePool implements RoomConnectionPool {
  constructor(private sockets: Map<string, SocketLike[]> = new Map()) {}
  add(roomId: string, s: SocketLike) {
    if (!this.sockets.has(roomId)) this.sockets.set(roomId, []);
    this.sockets.get(roomId)!.push(s);
  }
  others(roomId: string, exclude: SocketLike): SocketLike[] {
    return (this.sockets.get(roomId) ?? []).filter(s => s !== exclude);
  }
  all(roomId: string): SocketLike[] { return this.sockets.get(roomId) ?? []; }
  size(roomId: string): number { return (this.sockets.get(roomId) ?? []).length; }
}

describe('ConnectionHandler', () => {
  let store: InMemoryRoomStore;
  beforeEach(() => { store = new InMemoryRoomStore(); });

  it('fresh hello → welcome + snapshot + sync.complete', async () => {
    const sock = makeMockSocket();
    const pool = new FakePool();
    pool.add('r1', sock);
    const h = new ConnectionHandler('r1', sock, store, pool, () => {});

    await h.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });

    const types = sock.sent.map(m => m.type);
    expect(types).toEqual(['welcome', 'snapshot', 'sync.complete']);
    const welcome = sock.sent[0] as any;
    expect(welcome.clientId).toMatch(/^c_/);
    expect(welcome.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(welcome.opIdHead).toBe(0);
    const snap = sock.sent[1] as any;
    expect(snap.project.bpm).toBe(120);
  });

  it('rejects schema.version_mismatch as fatal', async () => {
    const sock = makeMockSocket();
    const pool = new FakePool();
    pool.add('r1', sock);
    const h = new ConnectionHandler('r1', sock, store, pool, () => {});

    await h.onMessage({ v:1, type:'hello', schemaVersion: 9999 });
    expect(sock.sent.find(m => m.type === 'error')).toBeTruthy();
    expect(sock.closed).toBe(true);
  });

  it('rejects unparseable first message', async () => {
    const sock = makeMockSocket();
    const pool = new FakePool();
    pool.add('r1', sock);
    const h = new ConnectionHandler('r1', sock, store, pool, () => {});

    await h.onMessage({ banana: true });
    expect(sock.closed).toBe(true);
  });

  it('resume with unknown clientId issues fresh identity + non-fatal error', async () => {
    const sock = makeMockSocket();
    const pool = new FakePool();
    pool.add('r1', sock);
    const h = new ConnectionHandler('r1', sock, store, pool, () => {});

    await h.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION,
      clientId: 'c_unknown', resumeFromOpId: 0 });

    const err = sock.sent.find(m => m.type === 'error') as any;
    expect(err.code).toBe('resume.unknown_client');
    expect(err.fatal).toBe(false);
    expect(sock.sent.find(m => m.type === 'welcome')).toBeTruthy();
  });

  it('room.full fatally rejects 5th client', async () => {
    const pool = new FakePool();
    // Pretend 5 sockets are already in the pool before this hello.
    for (let i = 0; i < 5; i++) pool.add('r1', makeMockSocket());
    const sock = makeMockSocket();
    pool.add('r1', sock);
    const h = new ConnectionHandler('r1', sock, store, pool, () => {});

    await h.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
    const err = sock.sent.find(m => m.type === 'error') as any;
    expect(err.code).toBe('room.full');
    expect(sock.closed).toBe(true);
  });
});
```

Run: expected 5/5 passing.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 214 + 5 = 219 tests pass.

```bash
git add -A
git commit -m "feat(server): ConnectionHandler — hello/welcome/snapshot/replay/sync.complete"
git checkout feature/ws-sync-protocol
git merge --no-ff task/07-server-connection-handler
```

---

## Task 8: Server — op handling (validate + append + broadcast + nack)

**Scope:** Extend `ConnectionHandler.onMessage` to process inbound `set` ops: validate against `@fiddle/shared`'s `validatePathAndValue`, enforce rate limit (token bucket), append via `RoomStore.appendOp`, and broadcast to the room with `opId` and `clientId`. Originator gets a `clientSeq` echo; everyone else doesn't.

**Files:**
- Modify: `packages/server/src/sync/ConnectionHandler.ts`
- Create: `packages/server/src/sync/rate-limit.ts`
- Create: `packages/server/src/sync/rate-limit.test.ts`
- Modify: `packages/server/src/sync/ConnectionHandler.test.ts`

- [ ] **Step 1: Rate limiter**

`packages/server/src/sync/rate-limit.ts`:

```ts
// Token bucket: 100 ops/sec sustained, burst 200, replenish every 10ms.
const CAPACITY = 200;
const REFILL_PER_TICK = 1;     // 1 token per 10 ms = 100/sec
const TICK_MS = 10;

export class TokenBucket {
  private tokens: number = CAPACITY;
  private lastRefill: number = Date.now();

  /** Returns true if a token was consumed; false if rate-limited. */
  consume(now: number = Date.now()): boolean {
    const elapsed = now - this.lastRefill;
    if (elapsed >= TICK_MS) {
      const ticks = Math.floor(elapsed / TICK_MS);
      this.tokens = Math.min(CAPACITY, this.tokens + ticks * REFILL_PER_TICK);
      this.lastRefill += ticks * TICK_MS;
    }
    if (this.tokens > 0) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 2: Rate limiter tests**

`packages/server/src/sync/rate-limit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TokenBucket } from './rate-limit.js';

describe('TokenBucket', () => {
  it('starts at full capacity (burst 200)', () => {
    const b = new TokenBucket();
    let allowed = 0;
    for (let i = 0; i < 250; i++) if (b.consume(0)) allowed += 1;
    expect(allowed).toBe(200);
  });

  it('refills 100 per second', () => {
    const b = new TokenBucket();
    for (let i = 0; i < 200; i++) b.consume(0);          // drain burst
    expect(b.consume(0)).toBe(false);                     // empty
    expect(b.consume(1000)).toBe(true);                   // 1s later: 100 refilled
    let drained = 0;
    for (let i = 0; i < 110; i++) if (b.consume(1000)) drained += 1;
    expect(drained).toBeGreaterThanOrEqual(99);
  });
});
```

- [ ] **Step 3: Wire op handling into `ConnectionHandler`**

Modify `packages/server/src/sync/ConnectionHandler.ts` to:

1. Import `validatePathAndValue` from `@fiddle/shared` and `TokenBucket` from `./rate-limit.js`.
2. Add `private bucket = new TokenBucket();` field.
3. In `onMessage`, replace the `msg.type === 'set'` stub with:

```ts
if (msg.type === 'set') {
  if (!this.clientId) return; // pre-hello guard already done above
  if (!this.bucket.consume()) {
    this.nack(msg.clientSeq, 'rate.limited', 'op rate limit exceeded');
    return;
  }
  const v = validatePathAndValue(msg.path, msg.value);
  if (!v.ok) {
    this.nack(msg.clientSeq, v.code, v.message);
    return;
  }
  const r = await this.store.appendOp(this.roomId, {
    clientId: this.clientId,
    clientSeq: msg.clientSeq,
    path: msg.path,
    value: msg.value,
  });
  if (!r.ok) {
    this.nack(msg.clientSeq, 'op.duplicate', 'op already in log');
    return;
  }
  // Broadcast to everyone, with clientSeq only echoed to originator.
  for (const sock of this.pool.all(this.roomId)) {
    const isOrig = (sock === this.socket);
    const broadcast: SetOpBroadcast = {
      v: 1, type: 'set',
      opId: r.op.opId,
      clientId: this.clientId,
      ...(isOrig ? { clientSeq: msg.clientSeq } : {}),
      path: msg.path,
      value: msg.value,
    };
    sock.send(broadcast);
  }
  return;
}
```

4. Add the helper:

```ts
private nack(clientSeq: number, code: NackCode, message: string): void {
  const n: NackMessage = { v:1, type:'nack', clientSeq, code, message };
  this.socket.send(n);
}
```

(Import `NackCode` and `NackMessage` from `@fiddle/shared`.)

- [ ] **Step 4: Extend `ConnectionHandler.test.ts`**

Add tests:

```ts
it('valid set op is appended and broadcast', async () => {
  const sock = makeMockSocket();
  const pool = new FakePool();
  pool.add('r1', sock);
  const h = new ConnectionHandler('r1', sock, store, pool, () => {});

  await h.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
  sock.sent.length = 0; // clear

  await h.onMessage({ v:1, type:'set', clientSeq: 1, path: ['bpm'], value: 140 });
  const broadcast = sock.sent.find(m => m.type === 'set') as any;
  expect(broadcast.opId).toBe(1);
  expect(broadcast.clientSeq).toBe(1); // originator echo
  expect(broadcast.value).toBe(140);
});

it('invalid path is nacked', async () => {
  const sock = makeMockSocket();
  const pool = new FakePool();
  pool.add('r1', sock);
  const h = new ConnectionHandler('r1', sock, store, pool, () => {});
  await h.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
  sock.sent.length = 0;

  await h.onMessage({ v:1, type:'set', clientSeq: 1, path: ['schemaVersion'], value: 99 });
  const nack = sock.sent.find(m => m.type === 'nack') as any;
  expect(nack.code).toBe('path.invalid');
});

it('invalid value is nacked', async () => {
  const sock = makeMockSocket();
  const pool = new FakePool();
  pool.add('r1', sock);
  const h = new ConnectionHandler('r1', sock, store, pool, () => {});
  await h.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
  sock.sent.length = 0;

  await h.onMessage({ v:1, type:'set', clientSeq: 1, path: ['bpm'], value: 9999 });
  const nack = sock.sent.find(m => m.type === 'nack') as any;
  expect(nack.code).toBe('value.invalid');
});

it('duplicate (clientId, clientSeq) is nacked', async () => {
  const sock = makeMockSocket();
  const pool = new FakePool();
  pool.add('r1', sock);
  const h = new ConnectionHandler('r1', sock, store, pool, () => {});
  await h.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
  await h.onMessage({ v:1, type:'set', clientSeq: 1, path: ['bpm'], value: 140 });
  sock.sent.length = 0;

  await h.onMessage({ v:1, type:'set', clientSeq: 1, path: ['bpm'], value: 150 });
  const nack = sock.sent.find(m => m.type === 'nack') as any;
  expect(nack.code).toBe('op.duplicate');
});

it('broadcast hides clientSeq from non-originators', async () => {
  const sockA = makeMockSocket();
  const sockB = makeMockSocket();
  const pool = new FakePool();
  pool.add('r1', sockA);
  pool.add('r1', sockB);
  const hA = new ConnectionHandler('r1', sockA, store, pool, () => {});
  const hB = new ConnectionHandler('r1', sockB, store, pool, () => {});

  await hA.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
  await hB.onMessage({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
  sockA.sent.length = 0; sockB.sent.length = 0;

  await hA.onMessage({ v:1, type:'set', clientSeq: 42, path: ['bpm'], value: 140 });

  const onA = sockA.sent.find(m => m.type === 'set') as any;
  const onB = sockB.sent.find(m => m.type === 'set') as any;
  expect(onA.clientSeq).toBe(42);
  expect(onB.clientSeq).toBeUndefined();
});
```

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 219 + 2 + 5 = 226 tests pass.

```bash
git add -A
git commit -m "feat(server): op handling with validation, rate limiting, and broadcast"
git checkout feature/ws-sync-protocol
git merge --no-ff task/08-server-op-handling
```

---

## Task 9: Server — heartbeat (ping/pong + dead-connection detection)

**Scope:** Server emits `ping` every 30 s per connection. If no `pong` within 60 s of the last `ping`, the server terminates the socket. Lives in the route layer (per-socket setInterval), but the ack-tracking logic is unit-testable.

**Files:**
- Create: `packages/server/src/sync/Heartbeat.ts`
- Create: `packages/server/src/sync/Heartbeat.test.ts`
- Modify: `packages/server/src/sync/ConnectionHandler.ts` (route `pong` to heartbeat)

- [ ] **Step 1: Heartbeat module**

`packages/server/src/sync/Heartbeat.ts`:

```ts
import type { SocketLike } from './SocketLike.js';
import type { PingMessage } from '@fiddle/shared';

const PING_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 60_000;

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();

  constructor(
    private readonly socket: SocketLike,
    private readonly nowFn: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onPong(): void {
    this.lastPongAt = this.nowFn();
  }

  /** Exposed for tests; called automatically every PING_INTERVAL_MS. */
  tick(): void {
    if (this.nowFn() - this.lastPongAt > TIMEOUT_MS) {
      this.socket.close(1011, 'pong timeout');
      this.stop();
      return;
    }
    const ping: PingMessage = { v:1, type:'ping' };
    this.socket.send(ping);
  }
}
```

- [ ] **Step 2: Tests**

`packages/server/src/sync/Heartbeat.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Heartbeat } from './Heartbeat.js';

function mockSocket() {
  return {
    sent: [] as any[], closed: false, readyState: 1,
    send(m: any) { this.sent.push(m); },
    close() { this.closed = true; },
  };
}

describe('Heartbeat', () => {
  it('sends ping on tick', () => {
    const sock = mockSocket();
    const hb = new Heartbeat(sock, () => 0);
    hb.tick();
    expect(sock.sent[0].type).toBe('ping');
  });

  it('does not close while pongs are arriving', () => {
    const sock = mockSocket();
    let now = 0;
    const hb = new Heartbeat(sock, () => now);
    hb.tick();         // t=0, ping
    now = 30_000;
    hb.onPong();       // pong arrives
    hb.tick();         // t=30s, ping again — pong was 0s ago
    expect(sock.closed).toBe(false);
  });

  it('closes socket on pong timeout', () => {
    const sock = mockSocket();
    let now = 0;
    const hb = new Heartbeat(sock, () => now);
    hb.tick();         // t=0, ping (last pong = 0)
    now = 70_000;      // 70s elapsed, no pong
    hb.tick();
    expect(sock.closed).toBe(true);
  });
});
```

- [ ] **Step 3: Wire into `ConnectionHandler`**

Add a `Heartbeat` instance to `ConnectionHandler`:

- Constructor accepts an optional `Heartbeat` (default: `new Heartbeat(this.socket)`).
- `handleHello` calls `this.heartbeat.start()` right before the closing log line.
- `onMessage` with `type === 'pong'` calls `this.heartbeat.onPong()`.
- `onClose` calls `this.heartbeat.stop()`.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 226 + 3 = 229 tests pass.

```bash
git add -A
git commit -m "feat(server): heartbeat (ping/pong + dead-connection detection)"
git checkout feature/ws-sync-protocol
git merge --no-ff task/09-server-heartbeat
```

---

## Task 10: Server — wire `ConnectionHandler` into the `/ws/:roomId` Fastify route

**Scope:** Replace the placeholder `packages/server/src/routes/ws.ts` with a real route that instantiates a `ConnectionHandler` per socket, manages the pool of sockets per room, and shuttles messages from the WS to the handler.

**Files:**
- Modify: `packages/server/src/routes/ws.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/server.test.ts`

- [ ] **Step 1: Pool implementation**

Add to `packages/server/src/sync/ConnectionPool.ts` (NEW file):

```ts
import type { SocketLike, RoomConnectionPool } from './SocketLike.js';

export class ConnectionPool implements RoomConnectionPool {
  private rooms = new Map<string, Set<SocketLike>>();

  add(roomId: string, socket: SocketLike): void {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set());
    this.rooms.get(roomId)!.add(socket);
  }

  remove(roomId: string, socket: SocketLike): void {
    const set = this.rooms.get(roomId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.rooms.delete(roomId);
  }

  others(roomId: string, exclude: SocketLike): SocketLike[] {
    const set = this.rooms.get(roomId);
    if (!set) return [];
    return [...set].filter(s => s !== exclude && s.readyState === 1);
  }

  all(roomId: string): SocketLike[] {
    return [...(this.rooms.get(roomId) ?? [])].filter(s => s.readyState === 1);
  }

  size(roomId: string): number {
    return this.all(roomId).length;
  }
}
```

(The `FakePool` in Task 7's tests uses a placeholder filter; update it to mirror `ConnectionPool.others` — filter by `s !== exclude`. The change is one line.)

- [ ] **Step 2: WS route**

`packages/server/src/routes/ws.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { ConnectionHandler } from '../sync/ConnectionHandler.js';
import type { SocketLike } from '../sync/SocketLike.js';
import type { RoomStore } from '../room/RoomStore.js';
import type { ConnectionPool } from '../sync/ConnectionPool.js';

interface Deps {
  store: RoomStore;
  pool: ConnectionPool;
}

function adaptSocket(ws: WebSocket): SocketLike {
  return {
    send(msg) { ws.send(JSON.stringify(msg)); },
    close(code, reason) { ws.close(code, reason); },
    get readyState() { return ws.readyState; },
  };
}

export async function wsRoute(app: FastifyInstance, deps: Deps) {
  app.get('/ws/:roomId', { websocket: true }, (socket, req) => {
    const params = req.params as { roomId: string };
    const roomId = params.roomId;
    const adapted = adaptSocket(socket as unknown as WebSocket);
    deps.pool.add(roomId, adapted);

    const handler = new ConnectionHandler(
      roomId,
      adapted,
      deps.store,
      deps.pool,
      (msg, fields) => app.log.info(fields ?? {}, msg),
    );

    socket.on('message', (raw: RawData) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); }
      catch { parsed = null; }
      handler.onMessage(parsed).catch(err => app.log.error({ err }, 'ws onMessage'));
    });

    socket.on('close', () => {
      deps.pool.remove(roomId, adapted);
      handler.onClose().catch(err => app.log.error({ err }, 'ws onClose'));
    });
  });
}
```

- [ ] **Step 3: Wire `RoomStore` + `ConnectionPool` into `server.ts`**

Modify `packages/server/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { healthRoute } from './routes/health.js';
import { wsRoute } from './routes/ws.js';
import { InMemoryRoomStore } from './room/InMemoryRoomStore.js';
import { ConnectionPool } from './sync/ConnectionPool.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const store = new InMemoryRoomStore();
  const pool = new ConnectionPool();
  app.register(websocket);
  app.register(healthRoute);
  app.register(async (a) => wsRoute(a, { store, pool }));
  return app;
}
```

- [ ] **Step 4: Update server smoke test**

The existing `packages/server/src/server.test.ts` smoke-tests `/health`. Keep it. Add a second test that uses `app.inject` for `/ws/:roomId` to verify the route is registered (full WS handshake testing is harder; this just confirms the route exists by checking the upgrade rejection on a non-upgrade request):

```ts
it('GET /ws/r1 without upgrade returns 426 or 400', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/ws/r1' });
  expect([400, 426]).toContain(res.statusCode);
  await app.close();
});
```

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 229 + 1 = 230 tests pass.

```bash
git add -A
git commit -m "feat(server): wire ConnectionHandler into /ws/:roomId route"
git checkout feature/ws-sync-protocol
git merge --no-ff task/10-server-ws-route
```

---

## Task 11: Client — `WsClient` (state machine + sessionStorage + reconnect)

**Scope:** A class that owns the WebSocket lifecycle on the client: connect, hello, state transitions (closed → opening → catching-up → live), sessionStorage persistence, exponential backoff reconnect. Exposes events (`onMessage`, `onStateChange`) for higher layers.

**Files:**
- Create: `packages/client/src/sync/WsClient.ts`
- Create: `packages/client/src/sync/WsClient.test.ts`
- Create: `packages/client/src/sync/roomId.ts`
- Create: `packages/client/src/sync/roomId.test.ts`

- [ ] **Step 1: `roomId.ts` — URL handling**

`packages/client/src/sync/roomId.ts`:

```ts
const CHARS = '0123456789abcdefghjkmnpqrstvwxyz'; // crockford base32
const ROOM_ID_LEN = 9;

export function generateRoomId(): string {
  let s = '';
  for (let i = 0; i < ROOM_ID_LEN; i++) {
    s += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return s;
}

/** Returns the roomId from the URL, generating + pushing one if absent. */
export function resolveRoomIdFromUrl(loc: Location = window.location): string {
  const m = loc.pathname.match(/^\/r\/([0-9a-z]{6,12})/i);
  if (m) return m[1];
  const fresh = generateRoomId();
  // history.replaceState so the new URL is visible without reloading.
  window.history.replaceState(null, '', `/r/${fresh}`);
  return fresh;
}
```

`packages/client/src/sync/roomId.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateRoomId, resolveRoomIdFromUrl } from './roomId.js';

describe('roomId', () => {
  it('generates correct length + alphabet', () => {
    const id = generateRoomId();
    expect(id).toMatch(/^[0-9a-z]{9}$/);
  });

  it('extracts roomId from /r/<id>', () => {
    const fakeLoc = { pathname: '/r/j7k2mq8n3' } as Location;
    expect(resolveRoomIdFromUrl(fakeLoc)).toBe('j7k2mq8n3');
  });

  it('case-insensitive match', () => {
    const fakeLoc = { pathname: '/r/J7K2MQ8N3' } as Location;
    expect(resolveRoomIdFromUrl(fakeLoc)).toBe('J7K2MQ8N3');
  });
});
```

(For the "no path" branch: that's exercised in integration tests later — jsdom's `window.history.replaceState` is mocked by jsdom but verifying it would require a real window.location setup. Skip in unit tests.)

- [ ] **Step 2: `WsClient`**

`packages/client/src/sync/WsClient.ts`:

```ts
import type { ServerMessage, ClientMessage, Identity } from '@fiddle/shared';
import { PROJECT_SCHEMA_VERSION } from '@fiddle/shared';

export type WsState = 'closed' | 'opening' | 'catching-up' | 'live';

export interface WsClientOpts {
  url: string;
  roomId: string;
  onMessage: (msg: ServerMessage) => void;
  onStateChange?: (state: WsState) => void;
  socketCtor?: typeof WebSocket;  // injectable for tests
  storage?: Storage;              // sessionStorage by default
}

interface PersistedState {
  clientId: string;
  opIdLastSeen: number;
  clientSeq: number;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private state: WsState = 'closed';
  private backoff = 1000;        // ms, exponential
  private readonly maxBackoff = 30_000;
  private readonly socketCtor: typeof WebSocket;
  private readonly storage: Storage;
  private readonly storageKey: string;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;

  // Outbound is paused while in {catching-up, opening, closed}.
  // Higher-level Outbox layer will be told to flush only after onStateChange('live').

  constructor(private readonly opts: WsClientOpts) {
    this.socketCtor = opts.socketCtor ?? WebSocket;
    this.storage = opts.storage ?? sessionStorage;
    this.storageKey = `fiddle:sync:${opts.roomId}`;
  }

  connect(): void {
    if (this.socket) return;
    this.intentionallyClosed = false;
    this.setState('opening');
    this.socket = new this.socketCtor(this.opts.url);
    this.socket.onopen = () => this.sendHello();
    this.socket.onmessage = (e) => this.onSocketMessage(e.data);
    this.socket.onclose = () => this.onSocketClose();
    this.socket.onerror = () => { /* close will follow */ };
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  send(msg: ClientMessage): void {
    if (this.state !== 'live') {
      throw new Error(`Cannot send in state ${this.state}`);
    }
    this.socket!.send(JSON.stringify(msg));
  }

  /** Caller (Outbox) reads this to know whether to dispatch immediately. */
  isLive(): boolean { return this.state === 'live'; }

  /** Persistent state for outbox to read clientSeq counter. */
  getPersisted(): PersistedState | null {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** Outbox calls this to advance the clientSeq counter atomically. */
  nextClientSeq(): number {
    const cur = this.getPersisted() ?? { clientId: '', opIdLastSeen: 0, clientSeq: 0 };
    cur.clientSeq += 1;
    this.storage.setItem(this.storageKey, JSON.stringify(cur));
    return cur.clientSeq;
  }

  /** applyOp layer calls this on each applied op. */
  recordOpIdSeen(opId: number): void {
    const cur = this.getPersisted();
    if (!cur) return;
    if (opId > cur.opIdLastSeen) {
      cur.opIdLastSeen = opId;
      this.storage.setItem(this.storageKey, JSON.stringify(cur));
    }
  }

  // === internals ===

  private setState(s: WsState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private sendHello(): void {
    const persisted = this.getPersisted();
    const hello = persisted?.clientId
      ? { v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION,
          clientId: persisted.clientId, resumeFromOpId: persisted.opIdLastSeen }
      : { v: 1, type: 'hello', schemaVersion: PROJECT_SCHEMA_VERSION };
    this.socket!.send(JSON.stringify(hello));
  }

  private onSocketMessage(raw: string | ArrayBuffer | Blob): void {
    if (typeof raw !== 'string') return;
    let msg: ServerMessage;
    try { msg = JSON.parse(raw) as ServerMessage; } catch { return; }

    // State transitions on certain message types.
    if (msg.type === 'welcome') {
      // Persist clientId.
      const persisted: PersistedState = this.getPersisted() ?? { clientId: '', opIdLastSeen: 0, clientSeq: 0 };
      if (persisted.clientId !== msg.clientId) {
        // Identity changed (fresh join, or unknown_client reissue) — reset clientSeq.
        persisted.clientId = msg.clientId;
        persisted.clientSeq = 0;
      }
      persisted.opIdLastSeen = msg.opIdHead;
      this.storage.setItem(this.storageKey, JSON.stringify(persisted));
      this.setState('catching-up');
    } else if (msg.type === 'sync.complete') {
      this.recordOpIdSeen(msg.opId);
      this.setState('live');
      this.backoff = 1000; // reset on successful sync
    } else if (msg.type === 'error' && msg.fatal) {
      this.intentionallyClosed = true; // don't auto-reconnect on fatal
    }

    // Auto-respond to ping.
    if (msg.type === 'ping') {
      this.socket?.send(JSON.stringify({ v:1, type:'pong' }));
    }

    this.opts.onMessage(msg);
  }

  private onSocketClose(): void {
    this.socket = null;
    if (this.intentionallyClosed) {
      this.setState('closed');
      return;
    }
    this.setState('closed');
    // Exponential backoff.
    const delay = this.backoff;
    this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay) as unknown as number;
  }
}
```

- [ ] **Step 3: Tests using a mock WebSocket**

`packages/client/src/sync/WsClient.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WsClient } from './WsClient.js';
import { PROJECT_SCHEMA_VERSION } from '@fiddle/shared';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  sent: string[] = [];
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.({}); }
  _open() { this.readyState = 1; this.onopen?.({}); }
  _msg(data: string) { this.onmessage?.({ data }); }
}

beforeEach(() => { MockWebSocket.instances = []; });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

describe('WsClient', () => {
  it('sends fresh hello on open', () => {
    const storage = memoryStorage();
    const onMessage = vi.fn();
    const c = new WsClient({
      url:'ws://test/ws/r1', roomId:'r1',
      onMessage, socketCtor: MockWebSocket as any, storage,
    });
    c.connect();
    MockWebSocket.instances[0]._open();
    const hello = JSON.parse(MockWebSocket.instances[0].sent[0]);
    expect(hello).toEqual({ v:1, type:'hello', schemaVersion: PROJECT_SCHEMA_VERSION });
  });

  it('sends resume hello when clientId is stored', () => {
    const storage = memoryStorage();
    storage.setItem('fiddle:sync:r1', JSON.stringify({ clientId:'c_old', opIdLastSeen: 42, clientSeq: 8 }));
    const c = new WsClient({
      url:'ws://test/ws/r1', roomId:'r1',
      onMessage: vi.fn(), socketCtor: MockWebSocket as any, storage,
    });
    c.connect();
    MockWebSocket.instances[0]._open();
    const hello = JSON.parse(MockWebSocket.instances[0].sent[0]);
    expect(hello.clientId).toBe('c_old');
    expect(hello.resumeFromOpId).toBe(42);
  });

  it('transitions to live on sync.complete', () => {
    const storage = memoryStorage();
    let state = '';
    const c = new WsClient({
      url:'ws://test/ws/r1', roomId:'r1',
      onMessage: vi.fn(),
      onStateChange: s => { state = s; },
      socketCtor: MockWebSocket as any, storage,
    });
    c.connect();
    const ws = MockWebSocket.instances[0];
    ws._open();
    ws._msg(JSON.stringify({ v:1, type:'welcome', clientId:'c_new', color:'#FF4136',
      handle:'Owl', opIdHead:0, schemaVersion: PROJECT_SCHEMA_VERSION, roster:[] }));
    ws._msg(JSON.stringify({ v:1, type:'sync.complete', opId:0 }));
    expect(state).toBe('live');
    expect(c.isLive()).toBe(true);
  });

  it('persists clientId on welcome', () => {
    const storage = memoryStorage();
    const c = new WsClient({
      url:'ws://test/ws/r1', roomId:'r1',
      onMessage: vi.fn(), socketCtor: MockWebSocket as any, storage,
    });
    c.connect();
    MockWebSocket.instances[0]._open();
    MockWebSocket.instances[0]._msg(JSON.stringify({
      v:1, type:'welcome', clientId:'c_new', color:'#FF4136',
      handle:'Owl', opIdHead: 100, schemaVersion: PROJECT_SCHEMA_VERSION, roster:[],
    }));
    expect(JSON.parse(storage.getItem('fiddle:sync:r1')!)).toEqual({
      clientId:'c_new', opIdLastSeen: 100, clientSeq: 0,
    });
  });

  it('auto-responds to ping with pong', () => {
    const storage = memoryStorage();
    const c = new WsClient({
      url:'ws://test/ws/r1', roomId:'r1',
      onMessage: vi.fn(), socketCtor: MockWebSocket as any, storage,
    });
    c.connect();
    const ws = MockWebSocket.instances[0];
    ws._open();
    ws.sent.length = 0;
    ws._msg(JSON.stringify({ v:1, type:'ping' }));
    expect(JSON.parse(ws.sent[0])).toEqual({ v:1, type:'pong' });
  });

  it('nextClientSeq increments monotonically across calls', () => {
    const storage = memoryStorage();
    storage.setItem('fiddle:sync:r1', JSON.stringify({ clientId:'c_new', opIdLastSeen: 0, clientSeq: 0 }));
    const c = new WsClient({
      url:'ws://test/ws/r1', roomId:'r1',
      onMessage: vi.fn(), socketCtor: MockWebSocket as any, storage,
    });
    expect(c.nextClientSeq()).toBe(1);
    expect(c.nextClientSeq()).toBe(2);
    expect(c.nextClientSeq()).toBe(3);
  });
});
```

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 230 + 3 + 6 = 239 tests pass.

```bash
git add -A
git commit -m "feat(client): WsClient state machine + sessionStorage + reconnect"
git checkout feature/ws-sync-protocol
git merge --no-ff task/11-client-ws-client
```

---

## Task 12: Client — `Outbox` (throttle, coalesce, priorValue, nack rollback prep)

**Scope:** The outbound layer between the watcher and the WS. Implements 50 ms throttle per path, immediate flush on gesture end, coalesce by path when offline, and stores `priorValue` for rollback on nack.

**Files:**
- Create: `packages/client/src/sync/Outbox.ts`
- Create: `packages/client/src/sync/Outbox.test.ts`

- [ ] **Step 1: Implementation**

`packages/client/src/sync/Outbox.ts`:

```ts
import type { Path, SetOpClient } from '@fiddle/shared';

interface PendingEntry {
  path: Path;
  value: unknown;
  priorValue: unknown;
  clientSeq: number | null;     // assigned at send time
  timer: ReturnType<typeof setTimeout> | null;
  // For rollback bookkeeping after send:
  sent: boolean;
}

const THROTTLE_MS = 50;

export interface OutboxDeps {
  /** Returns next clientSeq from WsClient/sessionStorage. */
  nextClientSeq: () => number;
  /** Send op now. Caller decides if connection is live; Outbox just hands it off. */
  send: (op: SetOpClient) => void;
  /** Apply `value` to local `project` along `path`, with applyingFromNetwork suppression. */
  applyLocal: (path: Path, value: unknown) => void;
  /** Returns true if the WS is in 'live' state (and we should actually send). */
  isLive: () => boolean;
}

export class Outbox {
  private pending = new Map<string, PendingEntry>();           // throttle / live pending
  private inFlight = new Map<number, PendingEntry>();          // sent, awaiting echo or nack
  private offlineQueue = new Map<string, PendingEntry>();      // disconnected; coalesced by path

  constructor(private readonly deps: OutboxDeps) {}

  /**
   * Called by the watcher when a local change happens.
   * gestureEnd=true forces immediate emission (mouseup, blur, etc.)
   */
  enqueue(path: Path, value: unknown, priorValue: unknown, gestureEnd: boolean): void {
    const key = JSON.stringify(path);

    // If offline, coalesce by path; do not start timers.
    if (!this.deps.isLive()) {
      const existing = this.offlineQueue.get(key);
      this.offlineQueue.set(key, {
        path, value,
        priorValue: existing?.priorValue ?? priorValue,
        clientSeq: null, timer: null, sent: false,
      });
      return;
    }

    // Live: cancel any existing timer for this path; merge priorValue.
    const existing = this.pending.get(key);
    if (existing?.timer) clearTimeout(existing.timer);

    const entry: PendingEntry = {
      path, value,
      priorValue: existing?.priorValue ?? priorValue,
      clientSeq: null, timer: null, sent: false,
    };

    if (gestureEnd) {
      this.flushEntry(key, entry);
    } else {
      entry.timer = setTimeout(() => {
        this.flushEntry(key, this.pending.get(key) ?? entry);
      }, THROTTLE_MS);
      this.pending.set(key, entry);
    }
  }

  /** Server confirmed our op. Drop the in-flight tracking. */
  onEcho(clientSeq: number): void {
    this.inFlight.delete(clientSeq);
  }

  /** Server rejected our op. Roll back local state. */
  onNack(clientSeq: number, _code: string): void {
    const entry = this.inFlight.get(clientSeq);
    if (!entry) return; // unknown clientSeq (e.g. server restarted); ignore
    this.inFlight.delete(clientSeq);
    this.deps.applyLocal(entry.path, entry.priorValue);
  }

  /** Called when the WS flips from {opening|catching-up} to live. Flushes offline queue. */
  onLive(): void {
    for (const entry of this.offlineQueue.values()) {
      this.flushEntry(JSON.stringify(entry.path), entry);
    }
    this.offlineQueue.clear();
  }

  /** Called when the WS goes from live → closed. Move pending into offline queue. */
  onClosed(): void {
    for (const [key, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      this.offlineQueue.set(key, { ...entry, timer: null });
    }
    this.pending.clear();
  }

  private flushEntry(key: string, entry: PendingEntry): void {
    this.pending.delete(key);
    if (!this.deps.isLive()) {
      this.offlineQueue.set(key, { ...entry, timer: null });
      return;
    }
    const clientSeq = this.deps.nextClientSeq();
    entry.clientSeq = clientSeq;
    entry.sent = true;
    this.inFlight.set(clientSeq, entry);
    const op: SetOpClient = {
      v: 1, type: 'set', clientSeq,
      path: entry.path, value: entry.value,
    };
    this.deps.send(op);
  }
}
```

- [ ] **Step 2: Tests**

`packages/client/src/sync/Outbox.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Outbox } from './Outbox.js';
import type { SetOpClient } from '@fiddle/shared';

interface Harness {
  outbox: Outbox;
  sent: SetOpClient[];
  applied: { path: any; value: any }[];
  live: { current: boolean };
  seq: number;
}

function harness(initiallyLive = true): Harness {
  const live = { current: initiallyLive };
  const sent: SetOpClient[] = [];
  const applied: { path: any; value: any }[] = [];
  let seq = 0;
  const outbox = new Outbox({
    nextClientSeq: () => ++seq,
    send: (op) => sent.push(op),
    applyLocal: (path, value) => applied.push({ path, value }),
    isLive: () => live.current,
  });
  return { outbox, sent, applied, live, seq };
}

describe('Outbox', () => {
  beforeEach(() => vi.useFakeTimers());

  it('throttles consecutive enqueues to one send after 50ms', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.enqueue(['bpm'], 122, 120, false);
    h.outbox.enqueue(['bpm'], 123, 120, false);
    expect(h.sent.length).toBe(0);
    vi.advanceTimersByTime(50);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].value).toBe(123); // last value wins
  });

  it('gestureEnd flushes immediately', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.enqueue(['bpm'], 130, 120, true);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].value).toBe(130);
  });

  it('coalesces by path while offline', () => {
    const h = harness(false);
    h.outbox.enqueue(['bpm'], 121, 120, false);
    h.outbox.enqueue(['bpm'], 122, 120, false);
    h.outbox.enqueue(['bpm'], 123, 120, false);
    expect(h.sent.length).toBe(0);
    h.live.current = true;
    h.outbox.onLive();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].value).toBe(123);
  });

  it('rolls back on nack', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 999, 120, true);
    expect(h.sent.length).toBe(1);
    const cs = h.sent[0].clientSeq;
    h.outbox.onNack(cs, 'value.invalid');
    expect(h.applied).toEqual([{ path: ['bpm'], value: 120 }]);
  });

  it('onEcho clears in-flight entry (no rollback)', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 140, 120, true);
    const cs = h.sent[0].clientSeq;
    h.outbox.onEcho(cs);
    h.outbox.onNack(cs, 'value.invalid'); // arriving stale; should be ignored
    expect(h.applied).toEqual([]);
  });

  it('different paths do not share throttle window', () => {
    const h = harness();
    h.outbox.enqueue(['bpm'], 130, 120, false);
    h.outbox.enqueue(['tracks', 0, 'mixer', 'volume'], 0.5, 1.0, false);
    vi.advanceTimersByTime(50);
    expect(h.sent.length).toBe(2);
  });
});
```

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 239 + 6 = 245 tests pass.

```bash
git add -A
git commit -m "feat(client): Outbox layer — throttle/coalesce/priorValue/rollback"
git checkout feature/ws-sync-protocol
git merge --no-ff task/12-client-outbox
```

---

## Task 13: Client — `applyOp` (inbound deep-set) + suppression flag

**Scope:** A small helper that applies an inbound op to the local Vue reactive `project`, with a module-scope `applyingFromNetwork` flag the watcher checks to skip outbound emission. Also handles the `lastAppliedOpIdForPath` dedup for late echoes.

**Files:**
- Create: `packages/client/src/sync/applyOp.ts`
- Create: `packages/client/src/sync/applyOp.test.ts`

- [ ] **Step 1: Implementation**

`packages/client/src/sync/applyOp.ts`:

```ts
import type { Path, Project, SetOpBroadcast } from '@fiddle/shared';

// Module-scope flag: set true while applyOp runs; the per-slice watcher
// in useSynth.ts checks this and skips calling Outbox.enqueue.
let applyingFromNetwork = false;
export function isApplyingFromNetwork(): boolean { return applyingFromNetwork; }

// Track the most recent opId applied to each path so a late echo of an
// older op cannot overwrite a newer one.
const lastAppliedOpIdForPath = new Map<string, number>();

export function applyOp(project: Project, op: SetOpBroadcast): boolean {
  const key = JSON.stringify(op.path);
  const prev = lastAppliedOpIdForPath.get(key) ?? -1;
  if (op.opId <= prev) return false;  // stale; ignore
  lastAppliedOpIdForPath.set(key, op.opId);

  applyingFromNetwork = true;
  try {
    setDeep(project as unknown as Record<string, unknown>, op.path, op.value);
  } finally {
    applyingFromNetwork = false;
  }
  return true;
}

export function resetApplyOpState(): void {
  // For tests + reconnect.
  lastAppliedOpIdForPath.clear();
}

function setDeep(obj: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 0) return;
  let cursor: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]];
    if (cursor == null) throw new Error(`applyOp: path break at segment ${i} (${String(path[i])})`);
  }
  cursor[path[path.length - 1]] = value;
}
```

- [ ] **Step 2: Tests**

`packages/client/src/sync/applyOp.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { applyOp, isApplyingFromNetwork, resetApplyOpState } from './applyOp.js';

describe('applyOp', () => {
  beforeEach(() => resetApplyOpState());

  it('applies a bpm set', () => {
    const p = freshProject();
    const ok = applyOp(p, { v:1, type:'set', opId: 1, clientId:'x', path:['bpm'], value: 140 });
    expect(ok).toBe(true);
    expect(p.bpm).toBe(140);
  });

  it('applies a deep nested set', () => {
    const p = freshProject();
    applyOp(p, { v:1, type:'set', opId: 1, clientId:'x',
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: 800 });
    expect(p.tracks[0].engines.synth.filterCutoff).toBe(800);
  });

  it('ignores stale opIds for the same path', () => {
    const p = freshProject();
    applyOp(p, { v:1, type:'set', opId: 5, clientId:'x', path:['bpm'], value: 150 });
    const ok = applyOp(p, { v:1, type:'set', opId: 3, clientId:'x', path:['bpm'], value: 130 });
    expect(ok).toBe(false);
    expect(p.bpm).toBe(150);
  });

  it('sets and resets the suppression flag', () => {
    const p = freshProject();
    expect(isApplyingFromNetwork()).toBe(false);
    applyOp(p, { v:1, type:'set', opId: 1, clientId:'x', path:['bpm'], value: 140 });
    expect(isApplyingFromNetwork()).toBe(false); // reset by finally
  });
});
```

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 245 + 4 = 249 tests pass.

```bash
git add -A
git commit -m "feat(client): applyOp — inbound deep-set + applyingFromNetwork flag"
git checkout feature/ws-sync-protocol
git merge --no-ff task/13-client-apply-op
```

---

## Task 14: Client — presence reactive store

**Scope:** A small reactive store (plain `ref`s, no Pinia) that holds the current `roster` and a `lastTouchedByPath` map. Updated by the message dispatcher in Task 15. Components read from it.

**Files:**
- Create: `packages/client/src/sync/presence.ts`
- Create: `packages/client/src/sync/presence.test.ts`

- [ ] **Step 1: Implementation**

`packages/client/src/sync/presence.ts`:

```ts
import { ref, type Ref } from 'vue';
import type { Identity, Path } from '@fiddle/shared';

export interface TouchedRecord {
  clientId: string;
  color: string;
  expiresAt: number;
}

export const roster: Ref<Identity[]> = ref([]);
export const selfClientId: Ref<string | null> = ref(null);

// Reactive map of pathKey → {clientId, color, expiresAt}. Set by remote
// ops. Components query touchedFor(path) for fade rendering.
const touchedMap = ref(new Map<string, TouchedRecord>());

const TOUCH_TTL_MS = 500;

export function noteRemoteTouch(path: Path, clientId: string): void {
  if (clientId === selfClientId.value) return;
  const r = roster.value.find(r => r.clientId === clientId);
  if (!r) return;
  const key = JSON.stringify(path);
  touchedMap.value.set(key, {
    clientId,
    color: r.color,
    expiresAt: Date.now() + TOUCH_TTL_MS,
  });
  // Schedule expiry — naive setTimeout per write; fine at our throttle.
  setTimeout(() => {
    const cur = touchedMap.value.get(key);
    if (cur && cur.expiresAt <= Date.now()) {
      touchedMap.value.delete(key);
      // Force reactivity by reassigning. (Map mutations don't always trigger.)
      touchedMap.value = new Map(touchedMap.value);
    }
  }, TOUCH_TTL_MS + 50);
}

export function touchedFor(path: Path): TouchedRecord | null {
  const rec = touchedMap.value.get(JSON.stringify(path));
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return rec;
}

export function resetPresence(): void {
  roster.value = [];
  selfClientId.value = null;
  touchedMap.value = new Map();
}
```

- [ ] **Step 2: Tests**

`packages/client/src/sync/presence.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { roster, selfClientId, noteRemoteTouch, touchedFor, resetPresence } from './presence.js';

describe('presence', () => {
  beforeEach(() => { resetPresence(); vi.useFakeTimers(); });

  it('records remote touch with the originator color', () => {
    roster.value = [
      { clientId:'me', color:'#000000', handle:'Self' as any },
      { clientId:'other', color:'#FF0000', handle:'Other' as any },
    ];
    selfClientId.value = 'me';
    noteRemoteTouch(['bpm'], 'other');
    expect(touchedFor(['bpm'])?.color).toBe('#FF0000');
  });

  it('ignores self touches', () => {
    roster.value = [{ clientId:'me', color:'#000000', handle:'Self' as any }];
    selfClientId.value = 'me';
    noteRemoteTouch(['bpm'], 'me');
    expect(touchedFor(['bpm'])).toBeNull();
  });

  it('expires after 500ms', () => {
    roster.value = [
      { clientId:'me', color:'#000000', handle:'Self' as any },
      { clientId:'other', color:'#FF0000', handle:'Other' as any },
    ];
    selfClientId.value = 'me';
    noteRemoteTouch(['bpm'], 'other');
    expect(touchedFor(['bpm'])).toBeTruthy();
    vi.advanceTimersByTime(600);
    expect(touchedFor(['bpm'])).toBeNull();
  });
});
```

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 249 + 3 = 252 tests pass.

```bash
git add -A
git commit -m "feat(client): presence reactive store + remote-touch tracking"
git checkout feature/ws-sync-protocol
git merge --no-ff task/14-client-presence
```

---

## Task 15: Client — integrate everything into `useSynth` (the heart of the change)

**Scope:** This is the integration task. After all the moving parts exist, wire them together inside `useSynth.ts`:

1. Construct `WsClient` lazily inside `ensureAudio()` (or earlier — connection can predate audio).
2. Construct `Outbox`, hooked to the WsClient.
3. Modify the per-slice watcher to call `Outbox.enqueue` in addition to `engine.applyParams`. The watcher must check `isApplyingFromNetwork()` and skip enqueueing when true.
4. Dispatch inbound messages: `set` → `applyOp` + `noteRemoteTouch` (if not self); `welcome`/`presence.update` → update `roster`; `snapshot` → `replaceProject`; `nack` → `outbox.onNack`; `error` → emit to error UI state.
5. Track gesture state on knobs (mouseup → `enqueue(..., gestureEnd=true)`).

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`
- Create: `packages/client/src/sync/messageDispatch.ts` (new dispatch helper to keep useSynth focused)
- Modify: `packages/client/src/composables/useSynth.test.ts`

- [ ] **Step 1: `messageDispatch.ts`**

`packages/client/src/sync/messageDispatch.ts`:

```ts
import type { ServerMessage, Project } from '@fiddle/shared';
import type { WsClient } from './WsClient.js';
import type { Outbox } from './Outbox.js';
import { applyOp, resetApplyOpState } from './applyOp.js';
import { roster, selfClientId, noteRemoteTouch } from './presence.js';
import { replaceProject } from '../project/storage.js';

export interface DispatchDeps {
  project: Project;
  wsClient: WsClient;
  outbox: Outbox;
  onFatalError: (code: string, message: string) => void;
}

export function dispatchServerMessage(msg: ServerMessage, deps: DispatchDeps): void {
  switch (msg.type) {
    case 'welcome':
      selfClientId.value = msg.clientId;
      roster.value = msg.roster;
      return;
    case 'snapshot':
      replaceProject(deps.project, msg.project);
      resetApplyOpState();
      return;
    case 'set':
      if (msg.clientSeq != null) {
        // Echo of our own op.
        deps.outbox.onEcho(msg.clientSeq);
        // Local state already matches (optimistic UI); applyOp still
        // updates lastAppliedOpIdForPath, which is what we want.
      }
      applyOp(deps.project, msg);
      if (msg.clientId !== selfClientId.value) {
        noteRemoteTouch(msg.path, msg.clientId);
      }
      deps.wsClient.recordOpIdSeen(msg.opId);
      return;
    case 'sync.complete':
      deps.outbox.onLive();
      return;
    case 'presence.update':
      roster.value = msg.roster;
      return;
    case 'nack':
      deps.outbox.onNack(msg.clientSeq, msg.code);
      return;
    case 'error':
      if (msg.fatal) deps.onFatalError(msg.code, msg.message);
      // Non-fatal errors: log only; the welcome + snapshot following will fix state.
      return;
    case 'ping':
      // WsClient already auto-pongs; no further action.
      return;
  }
}
```

- [ ] **Step 2: Modify `useSynth.ts`**

In `useSynth.ts`:

1. Add imports:

```ts
import { WsClient } from '../sync/WsClient.js';
import { Outbox } from '../sync/Outbox.js';
import { isApplyingFromNetwork } from '../sync/applyOp.js';
import { resolveRoomIdFromUrl } from '../sync/roomId.js';
import { dispatchServerMessage } from '../sync/messageDispatch.js';
import { ref } from 'vue';
```

2. Add module-scope state:

```ts
let wsClient: WsClient | null = null;
let outbox: Outbox | null = null;
const fatalError = ref<{ code: string; message: string } | null>(null);
```

3. In `buildAudioState` (or wherever audio state is constructed), construct WsClient + Outbox after the engines exist:

```ts
function buildSyncState(): void {
  if (wsClient) return;
  const roomId = resolveRoomIdFromUrl();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`;
  // (Or read VITE_WS_URL env if a separate server origin)
  wsClient = new WsClient({
    url: wsUrl,
    roomId,
    onMessage: (msg) => dispatchServerMessage(msg, {
      project, wsClient: wsClient!, outbox: outbox!,
      onFatalError: (code, message) => { fatalError.value = { code, message }; },
    }),
    onStateChange: (s) => {
      if (s === 'closed' && outbox) outbox.onClosed();
    },
  });
  outbox = new Outbox({
    nextClientSeq: () => wsClient!.nextClientSeq(),
    send: (op) => wsClient!.send(op),
    applyLocal: (path, value) => {
      // Suppress watcher outbound via applyingFromNetwork — use applyOp's
      // setDeep helper (export it or duplicate here). Easiest:
      // call applyOp with a synthesized SetOpBroadcast.
      const synthetic = {
        v: 1 as const, type: 'set' as const,
        opId: Number.MAX_SAFE_INTEGER, // ensure not stale
        clientId: 'rollback',
        path, value,
      };
      // Note: this is a rollback, so lastAppliedOpIdForPath should NOT
      // be updated. Quick & ugly: keep a separate setDeep helper that
      // doesn't track opIds. Extract setDeep from applyOp.ts and import it here.
      // (Refactor: split setDeep into its own file; rework applyOp.ts to use it.)
      // For now, the dispatcher handles rollback differently — see DESIGN NOTE below.
      const oldFlag = isApplyingFromNetwork();
      // … see DESIGN NOTE
    },
    isLive: () => !!wsClient?.isLive(),
  });
  wsClient.connect();
}
```

**DESIGN NOTE: applyLocal for rollback.** The cleanest implementation is to extract the raw `setDeep` from `applyOp.ts` into its own module (`packages/client/src/sync/setDeep.ts`), have both `applyOp` and `Outbox.applyLocal` use it, and use a separate "suppress" flag (`applyingFromNetwork`) that the outbox sets for the duration of a rollback write. Implement this refactor as a sub-step:

- Extract `setDeep` to `packages/client/src/sync/setDeep.ts`.
- Re-export `applyingFromNetwork` setter as `enterSuppress()` / `exitSuppress()` from `applyOp.ts`.
- Outbox's `applyLocal` wraps the `setDeep` write in `enterSuppress()` / `exitSuppress()`.

This needs a small refactor of Task 13's `applyOp.ts`. Do it in this task before wiring `useSynth`.

4. Modify the per-slice watcher to wrap its `engine.applyParams` call with an outbox-emit. The pseudo-code:

```ts
// Inside per-slice watcher (e.g. for project.tracks[i].engines.synth.filterCutoff):
watch(
  () => snapshot(project.tracks[i].engines.synth),
  (newVal, oldVal) => {
    const changed = diffParams(oldVal, newVal);
    if (Object.keys(changed).length === 0) return;
    if (project.tracks[i].engineType === 'synth') {
      engines[i].applyParams(changed);
    }
    if (!isApplyingFromNetwork() && outbox) {
      for (const [key, value] of Object.entries(changed)) {
        const path = ['tracks', i, 'engines', 'synth', key];
        const priorValue = (oldVal as any)[key];
        outbox.enqueue(path, value, priorValue, /*gestureEnd=*/false);
      }
    }
  },
  { deep: true }
);
```

(The `gestureEnd` flag will require `Knob.vue` to signal mouseup separately — Task 16. For Task 15, leave `gestureEnd=false` everywhere; throttle alone is functional, the gesture-end commit is a quality improvement layered next.)

5. The lazy `buildSyncState()` is called from `ensureAudio()` after the engines are built. (WS connection does NOT require audio; it could be earlier, but ordering them simplifies teardown.)

6. Export from `useSynth()`:
   - `fatalError` (read-only ref for the error overlay)
   - `roster` and `selfClientId` (imported and re-exported from presence)

- [ ] **Step 3: Browser verification (mandatory — open the app)**

This task is the integration; tests can't fully cover it. Verification:

1. `npm run dev` — start client + server.
2. Open two browser tabs to `http://localhost:5173`.
3. Tab A: URL gets `/r/{newId}`. Note the id.
4. Tab B: open the same `/r/{id}` URL.
5. In tab A, turn the filter cutoff knob. Tab B's knob should follow (~50–100 ms delay).
6. In tab A's DevTools network panel: filter to WS, see frames flowing.
7. Both tabs' top-bar should show two roster chips (Owl + Fox, different colors).
8. Closing tab B should remove its chip from tab A (presence.update).
9. Refresh tab A — its identity should be reissued (fresh tab session), tab B sees Owl/Fox roster update to Hawk + Fox (or whatever).

If any of these fail, **stop and debug before commit**. Document the failure in a note and dispatch a debug subagent if needed.

- [ ] **Step 4: Update existing useSynth tests if any break**

`useSynth.test.ts` may have tests that synchronously construct things that are now async / lazier (e.g. WsClient construction). For unit tests that don't intend to test sync, **stub the WsClient construction** with a no-op (extract a factory parameter from `buildSyncState` that tests can override).

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 252 ± any test count changes from useSynth modifications. Tests must pass.

```bash
git add -A
git commit -m "feat(client): integrate WsClient + Outbox + applyOp + presence into useSynth"
git checkout feature/ws-sync-protocol
git merge --no-ff task/15-client-integrate-sync
```

---

## Task 16: Client — UI surface: `RoomBar`, `ErrorOverlay`, `Knob` activity ring, gesture-end emission

**Scope:** The user-visible pieces that come after the core sync is working.

1. **`RoomBar.vue`** — a small top-bar component showing one chip per `roster` entry, colored.
2. **`ErrorOverlay.vue`** — a modal-style overlay shown when `fatalError.value !== null`. Different messages per error code (room.full, schema.version_mismatch, etc.) with appropriate next-step buttons.
3. **`Knob.vue`** — accept an optional `activityColor` prop derived from `touchedFor(path)`, render a colored fading ring around the knob track when set. The fade animation is CSS.
4. **`Knob.vue`** — emit a `gesture-end` event on mouseup that the parent component routes to outbox by setting a flag on the next change.

**Files:**
- Create: `packages/client/src/components/RoomBar.vue`
- Create: `packages/client/src/components/ErrorOverlay.vue`
- Modify: `packages/client/src/components/Knob.vue`
- Modify: `packages/client/src/App.vue` (mount RoomBar + ErrorOverlay)

- [ ] **Step 1: `RoomBar.vue`**

```vue
<template>
  <div class="room-bar">
    <div
      v-for="r in roster"
      :key="r.clientId"
      class="chip"
      :style="{ background: r.color, outlineColor: r.clientId === selfClientId ? 'white' : 'transparent' }"
    >
      {{ r.handle }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { roster, selfClientId } from '../sync/presence.js';
</script>

<style scoped>
.room-bar { display: flex; gap: 8px; padding: 4px 12px; }
.chip {
  padding: 2px 8px; border-radius: 12px; color: #111; font-size: 12px;
  outline: 2px solid transparent;
}
</style>
```

- [ ] **Step 2: `ErrorOverlay.vue`**

```vue
<template>
  <div v-if="fatalError" class="error-overlay">
    <div class="card">
      <h2>{{ heading }}</h2>
      <p>{{ message }}</p>
      <button v-if="canNewRoom" @click="goToNewRoom">Create a new room</button>
      <button v-else @click="reload">Reload</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSynth } from '../composables/useSynth.js';

const { fatalError } = useSynth();

const heading = computed(() => {
  switch (fatalError.value?.code) {
    case 'room.full':                  return 'Room is full';
    case 'schema.version_mismatch':    return 'Out of date';
    case 'protocol.version_mismatch':  return 'Out of date';
    case 'hello.invalid':              return 'Connection error';
    default:                            return 'Disconnected';
  }
});

const message = computed(() => fatalError.value?.message ?? '');
const canNewRoom = computed(() => fatalError.value?.code === 'room.full');

function goToNewRoom() {
  window.location.pathname = '/';
}
function reload() { window.location.reload(); }
</script>

<style scoped>
.error-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.card {
  background: #1a1a1a; padding: 24px 32px; border-radius: 8px; max-width: 400px;
  color: white;
}
.card button { margin-top: 12px; padding: 8px 16px; cursor: pointer; }
</style>
```

- [ ] **Step 3: `Knob.vue` activity ring**

Add prop and template fragment:

```vue
<script setup lang="ts">
import { touchedFor } from '../sync/presence.js';
import type { Path } from '@fiddle/shared';

const props = defineProps<{
  // ... existing props
  syncPath?: Path;   // optional; not all knobs are synced (visualizer etc.)
}>();

const activityColor = computed(() => {
  if (!props.syncPath) return null;
  return touchedFor(props.syncPath)?.color ?? null;
});
</script>

<template>
  <div class="knob" :class="{ 'remote-active': activityColor }"
       :style="activityColor ? { '--activity-color': activityColor } : {}">
    <!-- existing knob template -->
  </div>
</template>

<style scoped>
.knob.remote-active {
  box-shadow: 0 0 0 2px var(--activity-color);
  transition: box-shadow 500ms ease-out;
}
</style>
```

(Pass the `syncPath` prop from each parent panel — `SynthPanel.vue`, `KickPanel.vue`, etc. — where the `v-model`-bound trackParam already knows the path. This requires plumbing the path through each panel component. Small per-panel edit, mechanical.)

- [ ] **Step 4: `Knob.vue` gesture-end**

`Knob.vue` already detects mouseup at the end of drag. Add an emit:

```ts
const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void;
  (e: 'gesture-end'): void;
}>();

// On mouseup:
emit('gesture-end');
```

The parent panel can pass the event through. Higher up (`useSynth.ts`), the watcher needs to know "this is a gesture end" — easiest pattern: a `gestureEndingForPath: Path | null` reactive that components set on mouseup, that the watcher reads and resets:

```ts
// In useSynth or a small helper:
import { ref } from 'vue';
export const gestureEndingForPath = ref<Path | null>(null);

// In the watcher (Task 15 updates):
const gestureEnd = gestureEndingForPath.value &&
                   JSON.stringify(gestureEndingForPath.value) === JSON.stringify(path);
outbox.enqueue(path, value, priorValue, gestureEnd);
if (gestureEnd) gestureEndingForPath.value = null;
```

Each knob's `@gesture-end` handler sets `gestureEndingForPath` to its path before the next watcher tick.

- [ ] **Step 5: Mount RoomBar + ErrorOverlay in `App.vue`**

```vue
<template>
  <ErrorOverlay />
  <RoomBar />
  <!-- existing App.vue layout -->
</template>

<script setup lang="ts">
import RoomBar from './components/RoomBar.vue';
import ErrorOverlay from './components/ErrorOverlay.vue';
// existing imports
</script>
```

- [ ] **Step 6: Browser verification**

1. Two tabs on the same room.
2. Drag a knob in tab A — tab B's matching knob should briefly show a colored ring in tab A's color, fading out in ~500 ms.
3. Drop a step into mute in tab A — tab B updates.
4. Force a `room.full`: open 5 tabs to the same room. The 5th gets the ErrorOverlay with "Room is full" + "Create a new room" button.
5. The new-room button should reset to `/` and immediately reconnect to a fresh room.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
```

```bash
git add -A
git commit -m "feat(client): RoomBar + ErrorOverlay + Knob activity ring + gesture-end"
git checkout feature/ws-sync-protocol
git merge --no-ff task/16-client-ui-surface
```

---

## Task 17: End-to-end verification (manual; no commit)

**Scope:** A manual checklist to run before declaring the feature ready for review. No code changes; document the findings in the commit message of the final merge.

- [ ] **Two browsers, same room — golden path**

1. Tab A opens `localhost:5173`. URL replaces to `/r/{newId}`.
2. Tab B opens that URL.
3. Tab A turns filter cutoff. Tab B follows within ~100 ms.
4. Tab B turns BPM. Tab A follows.
5. Tab A swaps engine on track 0. Tab B's track 0 panel updates.
6. Both can play (local audio). They hear each other's mutations as if they were their own.

- [ ] **Reconnect during edit**

1. Both tabs live, BPM = 120.
2. Tab A: DevTools → Network → "Offline."
3. Tab A turns BPM continuously for 5 seconds (knob ramp).
4. Tab A: Network → "Online."
5. Tab A should reconnect, resume from last opId, and only the last BPM value should be sent (outbox coalesce).
6. Tab B should see one BPM update (the final value), not 100.

- [ ] **Server restart**

1. Both tabs live.
2. Kill the server (Ctrl+C on `npm run dev:server`).
3. Restart server.
4. Both tabs should auto-reconnect. Since the in-memory room state is gone, they both get a `resume.unknown_client` + fresh snapshot. The project state reverts to `freshProject()` (no localStorage merging — that's local-only). Acceptable for Phase 1.

- [ ] **Room cap**

1. Open 5 tabs to the same room.
2. The 5th gets ErrorOverlay → room.full → "Create a new room" button works.

- [ ] **Schema version mismatch (simulated)**

1. Temporarily bump `PROJECT_SCHEMA_VERSION` to 99 in `@fiddle/shared` on the client side, rebuild client. Leave server at 1.
2. Open the client. Should hit ErrorOverlay → schema.version_mismatch → "Reload" button shown.
3. Revert the change.

- [ ] **Single-user (no second tab) regression**

1. One tab open.
2. Project state still persists to localStorage and survives refresh.
3. Audio plays, sequencer runs, all engines respond to knobs. (Standard pre-sync behavior unaffected.)

- [ ] **Final code-review subagent**

After all manual verification passes:
- Run the final code-reviewer subagent (per `superpowers:subagent-driven-development` skill) against the full `feature/ws-sync-protocol` branch diff vs `main`.
- Address any Important issues.
- Commit fixes in a follow-up commit on `feature/ws-sync-protocol` (or on a `task/17-review-fixups` sub-branch merged back in).

- [ ] **Hand off to user for merge approval**

Do NOT merge to `main` or push to `origin`. Report status to user, wait for explicit approval.

---

## Out-of-scope reminders (for whoever picks this up)

Per the spec's "Out of scope" section, these are intentionally NOT part of this plan:
- Sync of `isPlaying` / transport position / step cursor.
- Server-side persistence across restart (Phase 2 work).
- Authentication / accounts.
- CRDTs.
- Op batching / multi-op frames.
- Tier C presence ("X is touching Y" with dedicated messages).

If during implementation a task feels like it needs one of these, **stop and consult the user** — adding scope mid-plan is the failure mode this list exists to prevent.
