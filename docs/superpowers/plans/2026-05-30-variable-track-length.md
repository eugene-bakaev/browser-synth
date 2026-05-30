# Variable Track Length (Polymeter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each track its own independent loop length (1–64 steps), sharing one downbeat and looping independently (polymeter), with non-destructive resizing over a fixed 64-step buffer.

**Architecture:** Each `ProjectTrack` always stores a 64-element `steps` buffer plus a `patternLength` field (1–64) that defines the play/render window. The sequencer drops its `% 16` and emits a monotonic absolute step index; the playback loop and UI apply `% patternLength` per track (Approach A — one scheduler, project-agnostic). `PROJECT_SCHEMA_VERSION` bumps 1 → 2 so the server's `hello` check rejects stale 16-step browser tabs; old localStorage/preset saves upgrade transparently via the existing `migrateToLatest` + `reconcileWithDefaults` path.

**Tech Stack:** TypeScript, Vue 3 (`<script setup>`, reactivity), Zod (wire schema), Vitest (unit), npm workspaces (`@fiddle/shared`, `@fiddle/client`, `@fiddle/server`), Playwright (e2e).

**Reference spec:** `docs/superpowers/specs/2026-05-30-variable-track-length-design.md`

**Naming:** the track-level field is `patternLength`. `Step.length` (note duration in ticks, max 16) is a different field and is unchanged.

**Per-task verification:** run the scoped command shown in each task. The full gate `npm run typecheck && npm test && npm run build` (plus Playwright e2e) runs in the final task. The repo uses **npm** — never introduce or commit a `pnpm-lock.yaml`.

---

## Task 1: Shared schema foundation — `patternLength`, 64-step buffer, version bump

**Files:**
- Modify: `packages/shared/src/index.ts:22`
- Modify: `packages/shared/src/project/types.ts:31-36`
- Modify: `packages/shared/src/project/factory.ts:23-44`
- Modify: `packages/shared/src/project/schema.ts:123-136`
- Test: `packages/shared/src/project/schema.test.ts`

- [ ] **Step 1: Bump the schema version**

In `packages/shared/src/index.ts`, change line 22:

```ts
export const PROJECT_SCHEMA_VERSION = 2 as const;
```

- [ ] **Step 2: Add `patternLength` to the `ProjectTrack` type**

In `packages/shared/src/project/types.ts`, update the interface (note the buffer-vs-window comment):

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
}
```

- [ ] **Step 3: Update the factory to build 64 steps + a default `patternLength`**

In `packages/shared/src/project/factory.ts`, replace `freshTrack`:

```ts
export function freshTrack(): ProjectTrack {
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
  };
}
```

(`freshProject()` already stamps `PROJECT_SCHEMA_VERSION` — it now stamps 2 automatically.)

- [ ] **Step 4: Update the Zod schema — 64-step array, `patternLength`, version literal**

In `packages/shared/src/project/schema.ts`, update `TrackSchema` and `ProjectSchema`:

```ts
const TrackSchema = z.object({
  engineType: EngineTypeSchema,
  engines: EnginesMapSchema,
  mixer: MixerSchema,
  // Track loop-window length (steps). The buffer below is fixed at 64.
  patternLength: z.number().int().min(1).max(64),
  steps: z.array(StepSchema).length(64),
});

export const ProjectSchema = z.object({
  schemaVersion: z.literal(2),
  bpm: z.number().int().min(40).max(240),
  tracks: z.array(TrackSchema).length(4),
});
```

Leave `StepSchema.length` (`z.number().int().min(1).max(16)`) untouched.

- [ ] **Step 5: Write/adjust the schema round-trip test**

In `packages/shared/src/project/schema.test.ts`, ensure a test asserts a fresh project parses and has the new shape. Add (or adapt an existing parse test to) this:

```ts
import { freshProject } from './factory';
import { Schemas } from './schema';

it('parses a fresh v2 project with 64-step buffers and patternLength', () => {
  const p = freshProject();
  expect(p.schemaVersion).toBe(2);
  expect(p.tracks[0].steps).toHaveLength(64);
  expect(p.tracks[0].patternLength).toBe(16);
  expect(Schemas.Project.safeParse(p).success).toBe(true);
});

it('rejects a project whose steps buffer is not exactly 64', () => {
  const p = freshProject();
  p.tracks[0].steps = p.tracks[0].steps.slice(0, 16);
  expect(Schemas.Project.safeParse(p).success).toBe(false);
});

it('rejects a patternLength outside 1..64', () => {
  const p = freshProject();
  p.tracks[0].patternLength = 65;
  expect(Schemas.Project.safeParse(p).success).toBe(false);
});
```

If the existing file already has a "parses fresh project" test asserting 16 steps / `schemaVersion: 1`, update those assertions to 64 / 2.

- [ ] **Step 6: Run shared tests to verify they pass**

Run: `npm run typecheck -w @fiddle/shared && npm test -w @fiddle/shared`
Expected: PASS. (Client typecheck will be red until Task 3 — that is expected and out of scope for this task's gate.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/src/project/types.ts packages/shared/src/project/factory.ts packages/shared/src/project/schema.ts packages/shared/src/project/schema.test.ts
git commit -m "feat(shared): variable track length schema — patternLength + 64-step buffer, schemaVersion 2

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Accept-list — `patternLength` path, schema branch, step bound 64

**Files:**
- Modify: `packages/shared/src/project/accept-list.ts:23-77` (PATTERNS), `:113-125` (bounds), `:148-158` (resolveLeafSchema)
- Test: `packages/shared/src/project/accept-list.test.ts`

- [ ] **Step 1: Write failing tests for the new path + step bound**

In `packages/shared/src/project/accept-list.test.ts`, add:

```ts
import { validatePathAndValue, pathIsWritable, indicesInRange } from './accept-list';

it('accepts a writable patternLength path with an in-range value', () => {
  expect(validatePathAndValue('tracks.0.patternLength', 32)).toEqual({ ok: true });
});

it('rejects patternLength out of range', () => {
  const r = validatePathAndValue('tracks.0.patternLength', 65);
  expect(r.ok).toBe(false);
});

it('allows step indices up to 63', () => {
  expect(pathIsWritable('tracks.0.steps.63.note')).toBe(true);
  expect(indicesInRange('tracks.0.steps.63.note')).toBe(true);
  expect(indicesInRange('tracks.0.steps.64.note')).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fiddle/shared -- accept-list`
Expected: FAIL (`patternLength` path not writable; step index 63 rejected by the old `STEP_COUNT = 16`).

- [ ] **Step 3: Add the `patternLength` pattern**

In `packages/shared/src/project/accept-list.ts`, add to the `PATTERNS` array (next to `['tracks', '*', 'engineType']`):

```ts
  ['tracks', '*', 'patternLength'],
```

- [ ] **Step 4: Bump the step bound to 64**

Change line 114:

```ts
const STEP_COUNT = 64;
```

- [ ] **Step 5: Resolve the `patternLength` leaf schema**

In `resolveLeafSchema`, add this branch right after the `engineType` branch (around line 151), so the int(1..64) range is enforced by Zod on inbound ops:

```ts
  if (trackKey === 'patternLength' && tokens.length === 3) {
    return trackShape.patternLength;
  }
```

- [ ] **Step 6: Run to verify pass**

Run: `npm run typecheck -w @fiddle/shared && npm test -w @fiddle/shared`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/project/accept-list.ts packages/shared/src/project/accept-list.test.ts
git commit -m "feat(shared): accept-list allows tracks.*.patternLength + step indices 0..63

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Client migration & reconcile — upgrade v1 saves, copy 64 steps + patternLength

**Files:**
- Modify: `packages/client/src/project/migrations.ts:12-29`
- Modify: `packages/client/src/project/storage.ts:32-60` (reconcileTrack), `:147-167` (replaceProject)
- Test: `packages/client/src/project/migrations.test.ts`, `packages/client/src/project/reconcile.test.ts`, `packages/client/src/project/storage.test.ts`

- [ ] **Step 1: Write failing tests for v1 → v2 upgrade**

In `packages/client/src/project/migrations.test.ts`, the existing test `passes a valid V1 doc through unchanged` is now wrong (a fresh project is v2). Replace it and add a v1-upgrade test:

```ts
it('passes a valid current-version doc through unchanged', () => {
  const p = freshProject(); // v2
  expect(migrateToLatest(p)).toBe(p);
});

it('upgrades a v1 doc past the version gate without throwing', () => {
  const v1 = { schemaVersion: 1, bpm: 120, tracks: [] };
  const out = migrateToLatest(v1);
  expect(out.schemaVersion).toBe(PROJECT_SCHEMA_VERSION); // 2
});

it('still throws for an unknown future schemaVersion', () => {
  expect(() => migrateToLatest({ schemaVersion: 99, bpm: 100, tracks: [] }))
    .toThrowError(/Unknown project schemaVersion: 99/);
});
```

In `packages/client/src/project/reconcile.test.ts`, add a test that reconciling a v1-shaped 16-step track pads to 64 and defaults `patternLength`:

```ts
import { reconcileWithDefaults } from './storage';

it('pads a 16-step v1 track to a 64-step buffer and defaults patternLength to 16', () => {
  const v1Track = { engineType: 'synth', engines: {}, mixer: {}, steps: Array.from({ length: 16 }, () => ({ note: 'C', octave: 4, length: 1, velocity: 0.8, muted: false })) };
  const out = reconcileWithDefaults({ schemaVersion: 1, bpm: 120, tracks: [v1Track] });
  expect(out.tracks[0].steps).toHaveLength(64);
  expect(out.tracks[0].steps[0].note).toBe('C');   // original data preserved
  expect(out.tracks[0].steps[20].note).toBe(null);  // padded with blanks
  expect(out.tracks[0].patternLength).toBe(16);     // defaulted
  expect(out.schemaVersion).toBe(2);
});

it('preserves an explicit patternLength when present', () => {
  const out = reconcileWithDefaults({ schemaVersion: 2, bpm: 120, tracks: [{ patternLength: 7 }] });
  expect(out.tracks[0].patternLength).toBe(7);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:client -- migrations reconcile`
Expected: FAIL (v1 doc throws; `patternLength` undefined; steps length 16).

- [ ] **Step 3: Add the v1 → v2 branch to `migrateToLatest`**

In `packages/client/src/project/migrations.ts`, insert before the `typeof v === 'number'` throw (after the `v === PROJECT_SCHEMA_VERSION` check):

```ts
  if (v === 1) {
    // v1 -> v2 is purely additive: the 16-step buffer is padded to 64 and
    // patternLength is defaulted, both completed by reconcileWithDefaults
    // downstream. We only need to let the doc past the version gate and stamp
    // the new version so this function's contract (returns a doc at the current
    // version) holds.
    return { ...(raw as object), schemaVersion: PROJECT_SCHEMA_VERSION } as unknown as Project;
  }
```

- [ ] **Step 4: Default `patternLength` in `reconcileTrack`**

In `packages/client/src/project/storage.ts`, add `patternLength` to the `reconciled` object in `reconcileTrack` (the existing `reconcileSteps(t.steps, fresh.steps)` already pads to 64 because `fresh.steps` is now 64):

```ts
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
    patternLength: typeof (t as { patternLength?: unknown }).patternLength === 'number'
      ? (t as { patternLength: number }).patternLength
      : fresh.patternLength,
    steps: reconcileSteps(t.steps, fresh.steps),
  };
```

- [ ] **Step 5: Fix `replaceProject` to copy all 64 steps + `patternLength`**

In `packages/client/src/project/storage.ts`, in `replaceProject` update the per-track copy. Change `t.engineType = s.engineType;` block to also copy `patternLength`, and change the step loop bound from 16 to 64:

```ts
    t.engineType = s.engineType;
    t.patternLength = s.patternLength;

    for (const engine of ENGINE_KEYS) {
      Object.assign(t.engines[engine], s.engines[engine]);
    }

    Object.assign(t.mixer, s.mixer);

    for (let j = 0; j < 64; j++) {
      Object.assign(t.steps[j], s.steps[j]);
    }
```

- [ ] **Step 6: Run to verify pass**

Run: `npm run typecheck:client && npm run test:client -- migrations reconcile storage`
Expected: PASS. (Other client test files may still be red — addressed in later tasks.)

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/project/migrations.ts packages/client/src/project/storage.ts packages/client/src/project/migrations.test.ts packages/client/src/project/reconcile.test.ts packages/client/src/project/storage.test.ts
git commit -m "feat(client): migrate v1 saves to v2 (pad to 64 steps, default patternLength); snapshot copies full buffer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Sequencer — absolute monotonic step counter (drop `% 16`)

**Files:**
- Modify: `packages/client/src/sequencer/Sequencer.ts:69-72`
- Test: `packages/client/src/sequencer/Sequencer.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or extend `packages/client/src/sequencer/Sequencer.test.ts`. The scheduler is driven by a fake `setInterval` + a stub `AudioContext`; assert the emitted indices increase monotonically past 16 without wrapping:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sequencer } from './Sequencer';

describe('Sequencer absolute counter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits a monotonically increasing absolute step index (no % 16 wrap)', () => {
    const seq = new Sequencer();
    const emitted: number[] = [];
    let now = 0;
    const ctx = { get currentTime() { return now; } } as unknown as AudioContext;

    seq.start(ctx, () => 120, (stepIndex) => emitted.push(stepIndex));
    // Advance enough wall-clock + audio-clock time to schedule > 16 steps.
    for (let i = 0; i < 40; i++) { now += 0.05; vi.advanceTimersByTime(25); }
    seq.stop();

    expect(emitted.length).toBeGreaterThan(16);
    expect(emitted[16]).toBe(16);            // would be 0 under the old % 16
    for (let i = 1; i < emitted.length; i++) {
      expect(emitted[i]).toBe(emitted[i - 1] + 1);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:client -- Sequencer`
Expected: FAIL (`emitted[16]` is `0` because of `% 16`).

- [ ] **Step 3: Remove the `% 16` wrap**

In `packages/client/src/sequencer/Sequencer.ts`, change line 70 inside the `while` loop:

```ts
        onStep(s.currentStep, nextStepTime);
        s.currentStep = s.currentStep + 1;
        s.nextStepIndex += 1;
```

Update the `SchedulerInternals.currentStep` doc comment to note it is now a monotonic absolute counter (per-track modulo is applied by the consumer), and that JS safe-integer range gives ~35M years of headroom at typical step rates so no wrap is needed.

- [ ] **Step 4: Run to verify pass**

Run: `npm run typecheck:client && npm run test:client -- Sequencer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sequencer/Sequencer.ts packages/client/src/sequencer/Sequencer.test.ts
git commit -m "feat(client): sequencer emits absolute monotonic step index (drop % 16)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Playback loop + `patternLength` sync watcher (`useSynth`)

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts:152-154` (DISCRETE set), `:391-407` (add watcher after steps watcher), `:506-511` (playback loop)
- Test: `packages/client/src/composables/useSynth.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/client/src/composables/useSynth.test.ts`, add this test inside the existing `describe('sync integration', ...)` block, mirroring the `emits a leaf op to the socket when a synth param changes` test. `patternLength` is a discrete leaf (immediate flush), so no `advanceTimersByTime` is strictly required, but include it to match the sibling tests and prove the op is sent:

```ts
  it('emits a patternLength op to the socket when a track length changes', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].patternLength = 8;
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'patternLength']);
    expect(fake.sent[0].value).toBe(8);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:client -- useSynth`
Expected: FAIL (no watcher emits the patternLength op).

- [ ] **Step 3: Mark `patternLength` as a discrete (immediate-flush) leaf**

In `packages/client/src/composables/useSynth.ts`, add `'patternLength'` to `DISCRETE_LEAF_FIELDS`:

```ts
const DISCRETE_LEAF_FIELDS = new Set<string>([
  'engineType', 'muted', 'soloed', 'note', 'octave', 'isChord', 'chordType', 'patternLength',
]);
```

- [ ] **Step 4: Add the per-track `patternLength` sync watcher**

In the `for (let i = 0; i < 4; i++)` watcher block, after the steps watcher (ends ~line 407), add — `flush:'sync'` + the `applyingFromNetwork` guard are mandatory (the suppression guard is only held synchronously; see the sync-suppression mechanism):

```ts
      // patternLength has no engine reaction (the sequencer reads it each tick
      // via the playback loop's modulo). This watcher exists purely to sync the
      // edit. Sync-flush + suppression guard, as with the other leaf watchers.
      watch(
        () => project.tracks[i].patternLength,
        (newVal, oldVal) => {
          if (outbox && !isApplyingFromNetwork()) {
            outbox.enqueue(['tracks', i, 'patternLength'], newVal, oldVal, gestureEndForLeaf('patternLength'));
          }
        },
        { flush: 'sync' },
      );
```

- [ ] **Step 5: Apply per-track modulo in the playback loop**

In `togglePlay`'s `onStep` callback, change line 511:

```ts
          const step = track.steps[stepIndex % track.patternLength];
```

(`currentStep.value = stepIndex;` keeps storing the absolute index — the UI mods it per track.)

- [ ] **Step 6: Run to verify pass**

Run: `npm run typecheck:client && npm run test:client -- useSynth`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): per-track modulo playback + patternLength sync watcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Window-only mutations + App handlers

**Files:**
- Modify: `packages/client/src/project/mutations.ts` (all three functions)
- Modify: `packages/client/src/App.vue:230-234` (handlers)
- Test: `packages/client/src/project/mutations.test.ts`

- [ ] **Step 1: Write failing tests for window-only behavior**

In `packages/client/src/project/mutations.test.ts`, add (and update any existing test that assumed full-64/16 operation):

```ts
import { clearTrack, shiftTrack, fillTrack } from './mutations';
import { freshTrack } from './factory';

it('clearTrack only clears within the window', () => {
  const t = freshTrack();
  t.patternLength = 4;
  t.steps[2].note = 'C';
  t.steps[10].note = 'E'; // outside window — must be preserved
  clearTrack(t, t.patternLength);
  expect(t.steps[2].note).toBe(null);
  expect(t.steps[10].note).toBe('E');
});

it('shiftTrack wraps within the window only', () => {
  const t = freshTrack();
  t.patternLength = 3;
  t.steps[0].note = 'C'; t.steps[1].note = 'D'; t.steps[2].note = 'E';
  t.steps[5].note = 'X'; // outside window — must not move
  shiftTrack(t, 'left', t.patternLength);
  expect([t.steps[0].note, t.steps[1].note, t.steps[2].note]).toEqual(['D', 'E', 'C']);
  expect(t.steps[5].note).toBe('X');
});

it('fillTrack only fills within the window', () => {
  const t = freshTrack();
  t.patternLength = 4;
  fillTrack(t, 2, t.patternLength);
  expect(t.steps[0].note).toBe('C');
  expect(t.steps[2].note).toBe('C');
  expect(t.steps[8].note).toBe(null); // outside window untouched
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:client -- mutations`
Expected: FAIL (functions take no `patternLength`; operate over all 64).

- [ ] **Step 3: Rewrite the mutations to take `patternLength`**

Replace `packages/client/src/project/mutations.ts` with:

```ts
import type { ProjectTrack } from './types';
import { freshStep } from './factory';

export function clearTrack(track: ProjectTrack, patternLength: number): void {
  for (let i = 0; i < patternLength; i++) {
    Object.assign(track.steps[i], freshStep());
  }
}

export function shiftTrack(track: ProjectTrack, direction: 'left' | 'right', patternLength: number): void {
  if (patternLength <= 1) return;
  // Rotate only the [0, patternLength) window in place, preserving the reactive
  // Step object identities (Object.assign into existing slots).
  const window = track.steps.slice(0, patternLength).map(s => ({ ...s }));
  for (let i = 0; i < patternLength; i++) {
    const src = direction === 'left'
      ? window[(i + 1) % patternLength]
      : window[(i - 1 + patternLength) % patternLength];
    Object.assign(track.steps[i], src);
  }
}

export function fillTrack(track: ProjectTrack, interval: number, patternLength: number): void {
  for (let i = 0; i < patternLength; i++) {
    if (i % interval === 0) {
      const step = track.steps[i];
      step.note = 'C';
      step.muted = false;
      step.velocity = 0.8;
      step.isChord = false;
      step.chordType = 'maj';
    }
  }
}
```

- [ ] **Step 4: Pass `patternLength` from the App handlers**

In `packages/client/src/App.vue`, update the three handlers (lines 230–234):

```ts
const onClear = (trackId: number) =>
  clearProjectTrack(project.tracks[trackId], project.tracks[trackId].patternLength);
const onShift = ({ trackId, direction }: { trackId: number; direction: 'left' | 'right' }) =>
  shiftProjectTrack(project.tracks[trackId], direction, project.tracks[trackId].patternLength);
const onFill = ({ trackId, interval }: { trackId: number; interval: number }) =>
  fillProjectTrack(project.tracks[trackId], interval, project.tracks[trackId].patternLength);
```

- [ ] **Step 5: Run to verify pass**

Run: `npm run typecheck:client && npm run test:client -- mutations`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/project/mutations.ts packages/client/src/App.vue packages/client/src/project/mutations.test.ts
git commit -m "feat(client): window-only clear/shift/fill (operate on 0..patternLength-1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Tracker UI — render window, per-track playhead, length input; TrackMixer modulo

**Files:**
- Modify: `packages/client/src/components/Tracker.vue` (template, script, toolbar, style)
- Modify: `packages/client/src/App.vue` (both `<Tracker>` instances + a `set-length` handler)
- Modify: `packages/client/src/components/TrackMixer.vue:93`

- [ ] **Step 1: Add the `patternLength` prop + `set-length` emit + window computed to `Tracker`**

In `packages/client/src/components/Tracker.vue` `<script setup>`, add `patternLength` to the props and a `set-length` emit, plus a computed window:

```ts
import { ref, computed } from 'vue';
// ...existing imports...

const props = withDefaults(defineProps<{
  steps: Step[];
  currentStep: number;
  title: string;
  color?: string;
  isFocused?: boolean;
  trackId: number;
  engineType: string;
  patternLength: number;
  mode?: 'mono' | 'poly';
}>(), {
  mode: 'mono'
});

const emit = defineEmits<{
  (e: 'select-track'): void;
  (e: 'clear', trackId: number): void;
  (e: 'shift', payload: { trackId: number; direction: 'left' | 'right' }): void;
  (e: 'fill', payload: { trackId: number; interval: number }): void;
  (e: 'set-length', payload: { trackId: number; length: number }): void;
}>();

// Only the [0, patternLength) window plays/renders. slice() keeps the underlying
// reactive Step references, so in-place edits still write through to `project`.
const visibleSteps = computed(() => props.steps.slice(0, props.patternLength));

const onLengthChange = (event: Event) => {
  const raw = parseInt((event.target as HTMLInputElement).value, 10);
  const length = Math.max(1, Math.min(64, Number.isFinite(raw) ? raw : props.patternLength));
  emit('set-length', { trackId: props.trackId, length });
};
```

- [ ] **Step 2: Render the window + per-track playhead in the template**

In `Tracker.vue`, change the step loop (line 59) to iterate `visibleSteps` and mod the playhead. Replace the `v-for` and the `active` class binding:

```html
      <div
        v-for="(step, i) in visibleSteps"
        :key="i"
        class="tracker-row step-row"
        :class="[
          engineType === 'synth'
            ? (mode === 'poly' ? 'chord-row' : 'synth-row')
            : 'drum-row',
          { active: currentStep >= 0 && (currentStep % patternLength) === i, 'step-muted': step.muted, 'with-vel': isFocused && engineType === 'synth' }
        ]"
      >
```

- [ ] **Step 3: Add the length number input to the toolbar**

In `Tracker.vue`, inside `.tracker-toolbar` (after the fill dropdown container, before its closing `</div>` at line 22), add:

```html
      <input
        type="number"
        class="tool-len"
        :value="patternLength"
        min="1"
        max="64"
        title="Pattern length (steps)"
        @change="onLengthChange"
      />
```

And add a style rule alongside the toolbar styles:

```css
.tool-len {
  flex: 1;
  height: 24px;
  min-width: 0;
  background: #181818;
  color: #aaa;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  text-align: center;
  padding: 0 4px;
}
.tool-len:focus {
  outline: none;
  border-color: var(--track-color);
  color: var(--track-color);
}
```

- [ ] **Step 4: Wire both `<Tracker>` instances + add the handler in `App.vue`**

In `packages/client/src/App.vue`, add `:patternLength` and `@set-length` to the overview `<Tracker>` (lines 27–42):

```html
        <Tracker
          v-for="(track, index) in project.tracks"
          :key="index"
          :steps="track.steps"
          :currentStep="currentStep"
          :title="`Track ${index + 1} [${getTrackEngineType(index).toUpperCase()}]`"
          :color="TRACK_COLORS[index]"
          :isFocused="false"
          :trackId="index"
          :engineType="getTrackEngineType(index)"
          :patternLength="track.patternLength"
          :mode="project.tracks[index].engines.synth.mode"
          @select-track="selectTrack(index)"
          @clear="onClear"
          @shift="onShift"
          @fill="onFill"
          @set-length="onSetLength"
        />
```

And the focused `<Tracker>` (lines 105–117) gains the same two bindings:

```html
            <Tracker
              :steps="project.tracks[activeTrackIndex].steps"
              :currentStep="currentStep"
              :title="`TRACK ${activeTrackIndex + 1}`"
              :color="TRACK_COLORS[activeTrackIndex]"
              :isFocused="true"
              :trackId="activeTrackIndex"
              :engineType="focusedTrack!.engineType"
              :patternLength="focusedTrack!.patternLength"
              :mode="focusedTrack!.engines.synth.mode"
              @clear="onClear"
              @shift="onShift"
              @fill="onFill"
              @set-length="onSetLength"
            />
```

(Preserve the focused Tracker's existing `:title`/other props exactly as they are in the file — only add `:patternLength` and `@set-length`.)

Add the handler next to `onFill` (after line 234):

```ts
const onSetLength = ({ trackId, length }: { trackId: number; length: number }) => {
  project.tracks[trackId].patternLength = Math.max(1, Math.min(64, length));
};
```

- [ ] **Step 5: Apply modulo in `TrackMixer`**

In `packages/client/src/components/TrackMixer.vue`, change line 93 inside `isTrackTriggered` (the `currentStep < 0` guard on line 90 already prevents a negative index):

```ts
  const step = track.steps[props.currentStep % track.patternLength];
```

- [ ] **Step 6: Verify typecheck, tests, and build**

Run: `npm run typecheck:client && npm run test:client && npm run build:client`
Expected: PASS (no component-mount tests exist for Tracker/TrackMixer, so this is typecheck + existing suite + a successful Vite build).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/Tracker.vue packages/client/src/components/TrackMixer.vue packages/client/src/App.vue
git commit -m "feat(client): Tracker renders patternLength window + length input; per-track playhead

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Full gate, server tests, and e2e

**Files:**
- Possibly modify: `packages/shared/src/protocol/schema.test.ts`, `packages/server/src/sync/protocol.e2e.test.ts`, `packages/server/src/sync/ConnectionHandler.test.ts` (only if they hardcode a 16-step project or `schemaVersion: 1` literally rather than via `PROJECT_SCHEMA_VERSION`)
- Reference: `e2e/` Playwright specs

- [ ] **Step 1: Run the full typecheck + unit gate**

Run: `npm run typecheck && npm test`
Expected: PASS. If any server/shared test fails, it is because it built a project inline with 16 steps or asserted a bare `schemaVersion: 1`. Fix by: building projects via `freshProject()`/`freshTrack()` from `@fiddle/shared`, or referencing `PROJECT_SCHEMA_VERSION`, or padding inline step arrays to 64. Do **not** weaken the schema to accept 16-step buffers. Re-run until green.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: PASS (client Vite build + server esbuild bundle).

- [ ] **Step 3: Run the Playwright e2e suite**

Run: `npm run e2e`
Expected: PASS. The existing two-client sync / engine-swap / mixer-mute / reconnect-flush specs must stay green (they exercise the snapshot + op paths that now carry 64-step buffers + patternLength).

- [ ] **Step 4: Add a polymeter e2e assertion (manual-equivalent automation)**

If the e2e harness supports it, add a spec: set track 1 `patternLength` to a small value (e.g. 4) via the toolbar input, confirm a `set` op for `['tracks', 0, 'patternLength']` is sent and that a second client's `patternLength` updates. If the harness can't easily drive the number input, document the manual verification steps in the PR description instead:
  - Two clients in one room; on client A set track 1 length to 4 and track 2 length to 7; press play.
  - Confirm independent looping (track 1 wraps every 4 steps, track 2 every 7) with a shared downbeat, and per-track playhead highlight.
  - Confirm the length change appears on client B.

- [ ] **Step 5: Commit any test fixups**

```bash
git add -A
git commit -m "test: update server/shared/e2e suites for 64-step buffers + patternLength

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## After all tasks

Dispatch a final holistic code review over the whole branch diff, then use **superpowers:finishing-a-development-branch**. Update `docs/ARCHITECTURE.md` (the "where to change things" table + a decision entry for the 64-buffer/patternLength model + the schema-version bump) and the `project_state` memory as a final documentation step before merge.
