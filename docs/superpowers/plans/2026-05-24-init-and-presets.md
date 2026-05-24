# Init New Project + Engine Presets + `playMode` Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `NEW` button, an engine-preset save/load workflow (`.chnl.json`), and the supporting `playMode → SynthEngineParams.mode` refactor.

**Architecture:** Three coordinated workstreams on `feature/init-and-presets`. The refactor lands first (so presets can serialize synth's `mode` cleanly), then the NEW button, then preset save/load. Each task is implemented on its own sub-branch off `feature/init-and-presets` and merged back with `git merge --no-ff` after green checkpoints. No remote push and no merge to `main` until user approval.

**Tech Stack:** Vue 3 + TypeScript + Vite + Vitest, File System Access API with `<a download>` / `<input type=file>` fallbacks. jsdom for DOM-touching test files (already a devDependency).

**Spec:** `docs/superpowers/specs/2026-05-24-init-and-presets-design.md` — read it first.

**Baseline:** branch `feature/init-and-presets` at `5bdffcb`, 143 tests passing, `vue-tsc` + `vite build` clean.

---

## File Structure (locked before tasks)

```
src/engine/
└── SynthEngine.ts                 # MODIFY — SynthEngineParams gains `mode`; DEFAULT_PARAMS.mode = 'mono'

src/project/
├── types.ts                       # MODIFY — ProjectTrack loses playMode
├── factory.ts                     # MODIFY — freshTrack drops playMode line
├── storage.ts                     # MODIFY — reconcileTrack: drop playMode line, add legacy compat read; replaceProject drops playMode line
├── storage.test.ts                # MODIFY — add legacy compat test; update any existing playMode references
├── preset.ts                      # CREATE — Preset type, makePreset, serializePreset, deserializePreset, applyPreset
├── preset.test.ts                 # CREATE
├── preset-file-io.ts              # CREATE — savePresetToFile, openPresetFromFile, PresetFileError
├── preset-file-io.test.ts         # CREATE
├── file-io.ts                     # MODIFY — suggested name + picker filter use .prj.json; open picker accepts both .json and .prj.json
├── file-io.test.ts                # MODIFY — expectations follow new suggested names
└── index.ts                       # MODIFY — re-export preset API

src/composables/
├── useSynth.ts                    # MODIFY — sequencer reads track.engines.synth.mode; `playMode` computed renamed to `synthMode`; trackParam used for `synth.mode`
└── useSynth.test.ts               # MODIFY — chord-mode regression now tests via synth.mode

src/components/
├── Tracker.vue                    # MODIFY — remove mono/chord toggle UI; rename `playMode` prop → `mode`; row-render branch reads `mode`
├── SynthPanel.vue                 # MODIFY — add mono/poly toggle; expose v-model:mode
└── App.vue                        # MODIFY — Tracker invocation drops v-model:playMode; SynthPanel invocation adds v-model:mode; add NEW button + handler; add SAVE PRESET / LOAD PRESET in focused-view-header

docs/
└── ARCHITECTURE.md                # MODIFY — §13 paragraph on presets + `.prj.json` / `.chnl.json` convention
```

---

## Task Overview

| # | Workstream | Title |
|---|---|---|
| T1 | Refactor | Add `mode` to SynthEngineParams + DEFAULT_PARAMS |
| T2 | Refactor | Reconciler legacy `playMode` compat read |
| T3 | Refactor | Switch reads to `synth.mode`; remove `ProjectTrack.playMode`; move toggle to SynthPanel |
| T4 | Init | NEW button + handler |
| T5 | Presets | `preset.ts` data module |
| T6 | Presets | `preset-file-io.ts` file I/O module |
| T7 | Presets | Project file extension `.json` → `.prj.json` |
| T8 | Presets | SAVE PRESET / LOAD PRESET buttons + ARCHITECTURE doc |

**Per-task workflow:**
1. Start from `feature/init-and-presets` clean tree.
2. Create sub-branch: `git checkout -b task/<short-name>`.
3. Implement task steps (TDD where applicable).
4. Run gates: `npm test`, `npx vue-tsc --noEmit`, `npm run build`. All green.
5. Commit on sub-branch with a descriptive message.
6. `git checkout feature/init-and-presets && git merge --no-ff task/<short-name> -m "Merge T<N>: <subject>"`.
7. Move to next task.

---

## Task 1: Add `mode` to SynthEngineParams + DEFAULT_PARAMS

**Sub-branch:** `task/synth-mode-field`

**Files:**
- Modify: `src/engine/SynthEngine.ts:11-25` (interface), `src/engine/SynthEngine.ts:37-52` (DEFAULT_PARAMS)
- Modify: `src/project/factory.ts:26-40` (freshTrack still has `playMode: 'mono'` — leave it; T3 removes it)
- Test: `src/project/factory.test.ts` (add assertion that `synth.mode === 'mono'` after freshTrack)

### Step 1.1: Create sub-branch

- [ ] **Step 1.1**

```bash
git checkout feature/init-and-presets
git checkout -b task/synth-mode-field
```

### Step 1.2: Add failing test

- [ ] **Step 1.2: Add the failing assertion in `src/project/factory.test.ts`**

Open `src/project/factory.test.ts` and add this test (or extend the existing `freshTrack` test):

```ts
it('freshTrack synth defaults include mode = mono', () => {
  const t = freshTrack();
  expect(t.engines.synth.mode).toBe('mono');
});
```

### Step 1.3: Run, verify fail

- [ ] **Step 1.3**

```bash
npx vitest run src/project/factory.test.ts
```

**Expected:** the new test fails with `Cannot read properties of undefined (reading 'mode')` or `expected undefined to be 'mono'`. TypeScript also errors on the access `t.engines.synth.mode` because `SynthEngineParams` has no `mode` field. Both signals confirm the failure.

### Step 1.4: Add `mode` to the interface

- [ ] **Step 1.4: Edit `src/engine/SynthEngine.ts`**

Replace lines 11-25 (the `SynthEngineParams` interface) with:

```ts
export interface SynthEngineParams {
  osc1Type: OscillatorType;
  osc2Type: OscillatorType;
  osc1Coarse: number;
  osc1Fine: number;
  osc2Coarse: number;
  osc2Fine: number;
  osc1Level: number;
  osc2Level: number;
  filterCutoff: number;
  filterRes: number;
  filterEnvAmount: number;
  filterEnv: ADSR;
  ampEnv: ADSR;
  mode: 'mono' | 'poly';
}
```

### Step 1.5: Add `mode` to DEFAULT_PARAMS

- [ ] **Step 1.5: Edit `src/engine/SynthEngine.ts:37-52`**

Replace the `DEFAULT_PARAMS` static literal with:

```ts
static readonly DEFAULT_PARAMS: SynthEngineParams = {
  osc1Type: 'sawtooth',
  osc2Type: 'sawtooth',
  osc1Coarse: 0,
  osc1Fine: 0,
  osc2Coarse: 0,
  osc2Fine: 0,
  osc1Level: 0.5,
  osc2Level: 0.5,
  filterCutoff: 2000,
  filterRes: 1,
  // In octaves (bipolar). See SynthVoice.FILTER_ENV_MAX_OCTAVES for range.
  filterEnvAmount: 2.4,
  filterEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
  ampEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
  mode: 'mono',
};
```

Note: `mode` is not applied to audio voices by `SynthEngine.applyParams` — it is purely a sequencer-level concern. No `setMode()` method, no voice broadcast. The synth engine just carries the value through serialize/deserialize.

### Step 1.6: Run the failing test again

- [ ] **Step 1.6**

```bash
npx vitest run src/project/factory.test.ts
```

**Expected:** the new test now passes. Existing factory tests still pass.

### Step 1.7: Run full gates

- [ ] **Step 1.7**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** all 144 tests pass (143 + the new one), `vue-tsc` clean, `vite build` clean.

### Step 1.8: Commit

- [ ] **Step 1.8**

```bash
git add src/engine/SynthEngine.ts src/project/factory.test.ts
git commit -m "feat(engine): add mode field to SynthEngineParams (default mono)

Pure type/default addition. mode is a sequencer-level concern (used by
the chord-vs-mono triggering loop in useSynth) and is intentionally not
broadcast to SynthVoice — no setMode(), no applyParams entry. The synth
engine just carries the value through serialize/deserialize. T2 wires
the reconciler to populate it from legacy playMode; T3 switches the
sequencer to read from it."
```

### Step 1.9: Merge into feature branch

- [ ] **Step 1.9**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/synth-mode-field -m "Merge T1: synth.mode field"
git log --oneline -3
```

**Expected:** merge commit on top of `5bdffcb`; sub-branch can be deleted later or left for reference.

---

## Task 2: Reconciler legacy `playMode` compat read

**Sub-branch:** `task/reconciler-legacy-playmode`

**Files:**
- Modify: `src/project/storage.ts:32-50` (`reconcileTrack`)
- Test: `src/project/storage.test.ts` (add legacy-compat test)

### Step 2.1: Create sub-branch

- [ ] **Step 2.1**

```bash
git checkout -b task/reconciler-legacy-playmode
```

### Step 2.2: Write the failing test

- [ ] **Step 2.2: Add to `src/project/storage.test.ts`**

Add this `describe` block near other `reconcileWithDefaults` tests (find them with `grep -n "describe.*reconcile" src/project/storage.test.ts`):

```ts
describe('reconcileWithDefaults — legacy playMode compat', () => {
  it('translates track.playMode === "chord" into track.engines.synth.mode === "poly"', () => {
    const legacy = {
      schemaVersion: 1,
      bpm: 120,
      tracks: [
        { playMode: 'chord' },
        { playMode: 'mono' },
        { playMode: 'chord' },
        {},  // no playMode at all
      ],
    };
    const out = reconcileWithDefaults(legacy);
    expect(out.tracks[0].engines.synth.mode).toBe('poly');
    expect(out.tracks[1].engines.synth.mode).toBe('mono');
    expect(out.tracks[2].engines.synth.mode).toBe('poly');
    expect(out.tracks[3].engines.synth.mode).toBe('mono');
  });

  it('drops the legacy playMode field from the reconciled track', () => {
    const legacy = {
      schemaVersion: 1,
      tracks: [{ playMode: 'chord' }, {}, {}, {}],
    };
    const out = reconcileWithDefaults(legacy) as unknown as { tracks: any[] };
    expect('playMode' in out.tracks[0]).toBe(false);
  });
});
```

### Step 2.3: Run, verify fail

- [ ] **Step 2.3**

```bash
npx vitest run src/project/storage.test.ts
```

**Expected:** the two new tests fail. `engines.synth.mode` is `'mono'` (the DEFAULT_PARAMS default from T1), so the `'poly'` expectations fail. The `'playMode' in tracks[0]` test passes already because the existing reconciler rebuilds a fresh-shaped object — keep both tests anyway as regression guards.

### Step 2.4: Update `reconcileTrack`

- [ ] **Step 2.4: Edit `src/project/storage.ts:32-50`**

Replace the existing `reconcileTrack` function body with:

```ts
function reconcileTrack(loaded: unknown): ProjectTrack {
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
    playMode: (t.playMode as ProjectTrack['playMode']) ?? fresh.playMode,
    steps: reconcileSteps(t.steps, fresh.steps),
  };

  // Legacy compat: pre-refactor localStorage / .prj.json files stored
  // playMode on the track. No schema bump (zero users) — silently absorb
  // the old field into synth.mode here. The old playMode field itself
  // gets dropped at T3 when ProjectTrack drops the type.
  if ((t as any).playMode === 'chord') {
    reconciled.engines.synth.mode = 'poly';
  }

  return reconciled;
}
```

Note: we are intentionally keeping the `playMode` line in `reconciled` for this task. It is removed in T3 alongside the `ProjectTrack` type change. Doing it here would leave the field-removal half-done.

### Step 2.5: Run the failing tests again

- [ ] **Step 2.5**

```bash
npx vitest run src/project/storage.test.ts
```

**Expected:** the two new tests pass. All other storage tests pass.

### Step 2.6: Run full gates

- [ ] **Step 2.6**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** 146 tests pass (144 + the 2 new), `vue-tsc` clean, `vite build` clean.

### Step 2.7: Commit

- [ ] **Step 2.7**

```bash
git add src/project/storage.ts src/project/storage.test.ts
git commit -m "feat(project): reconciler reads legacy playMode into synth.mode

Pre-refactor localStorage state and .prj.json files stored playMode on
the track. No formal migration (zero users; PROJECT_SCHEMA_VERSION stays
at 1) — instead, reconcileTrack absorbs the legacy field into
engines.synth.mode at load time. ProjectTrack still carries playMode for
one more task; T3 removes the field type and freshTrack value."
```

### Step 2.8: Merge

- [ ] **Step 2.8**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/reconciler-legacy-playmode -m "Merge T2: legacy playMode compat read"
```

---

## Task 3: Switch reads to `synth.mode`; remove `ProjectTrack.playMode`; move toggle to SynthPanel

**Sub-branch:** `task/playmode-refactor-cutover`

This is the atomic switch: the sequencer reads from `track.engines.synth.mode`, the `ProjectTrack.playMode` field is gone from the type/factory/replaceProject, useSynth exposes `synthMode` instead of `playMode`, the Tracker mono/poly toggle moves to SynthPanel, and App.vue is rewired.

**Files:**
- Modify: `src/composables/useSynth.ts` (sequencer line 345; computed lines 259-264; return-object line 386)
- Modify: `src/composables/useSynth.test.ts` (chord-mode regression test switches to synth.mode)
- Modify: `src/project/types.ts:34-40` (remove `playMode` from `ProjectTrack`)
- Modify: `src/project/factory.ts:37` (remove `playMode: 'mono',` line from `freshTrack`)
- Modify: `src/project/factory.test.ts` (remove or update any `playMode` assertions)
- Modify: `src/project/storage.ts:32-50` (drop `playMode` line from `reconciled` literal)
- Modify: `src/project/storage.ts:146` (remove `t.playMode = s.playMode;` line from `replaceProject`)
- Modify: `src/project/storage.test.ts` (any `playMode` references in test fixtures)
- Modify: `src/components/Tracker.vue` (remove the playmode-selector block ~lines 24-46; rename `playMode` prop to `mode`; update row-render branches)
- Modify: `src/components/SynthPanel.vue` (add mono/poly toggle; new `mode` v-model)
- Modify: `src/App.vue` (Tracker invocations: drop `v-model:playMode`; SynthPanel invocation: add `v-model:mode="synthMode"`)

### Step 3.1: Create sub-branch

- [ ] **Step 3.1**

```bash
git checkout -b task/playmode-refactor-cutover
```

### Step 3.2: Update useSynth sequencer read

- [ ] **Step 3.2: Edit `src/composables/useSynth.ts`**

At line 345 (inside `togglePlay`'s `sequencer.start` callback):

Replace:
```ts
const currentPlayMode = track.playMode || 'mono';
```

With:
```ts
const currentPlayMode = track.engines.synth.mode;
```

### Step 3.3: Rename `playMode` computed to `synthMode`

- [ ] **Step 3.3: Edit `src/composables/useSynth.ts:259-264`**

Replace:

```ts
const playMode = computed({
  get: () => activeTrackIndex.value !== null ? project.tracks[activeTrackIndex.value].playMode : 'mono' as const,
  set: (val: 'mono' | 'chord') => {
    if (activeTrackIndex.value !== null) project.tracks[activeTrackIndex.value].playMode = val;
  }
});
```

With:

```ts
const synthMode = computed({
  get: () => activeTrackIndex.value !== null
    ? project.tracks[activeTrackIndex.value].engines.synth.mode
    : 'mono' as const,
  set: (val: 'mono' | 'poly') => {
    if (activeTrackIndex.value !== null) {
      project.tracks[activeTrackIndex.value].engines.synth.mode = val;
    }
  }
});
```

### Step 3.4: Update useSynth return + remove `playMode` export

- [ ] **Step 3.4: Edit `src/composables/useSynth.ts` (the `return { ... }` block)**

In the returned object, replace the line `playMode,` with `synthMode,`. The full neighborhood looks like:

```ts
return {
  project,
  sequencer,
  bpm,
  analyser,
  trackGains,
  activeTrackIndex,
  currentStep,
  waveforms,
  engineType,
  synthMode,         // was: playMode
  osc1Type,
  osc2Type,
  // ... rest unchanged
```

### Step 3.5: Update useSynth chord-mode regression test

- [ ] **Step 3.5: Edit `src/composables/useSynth.test.ts`**

Search for `playMode` references with:

```bash
grep -n "playMode" src/composables/useSynth.test.ts
```

For each hit, replace fixture writes like `project.tracks[i].playMode = 'chord'` with `project.tracks[i].engines.synth.mode = 'poly'`. Replace reads of the exported `playMode` binding with `synthMode`. Replace value comparisons of `'chord'` with `'poly'` and `'mono'` stays `'mono'`.

### Step 3.6: Remove `playMode` from `ProjectTrack` type

- [ ] **Step 3.6: Edit `src/project/types.ts:34-40`**

Replace:

```ts
export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;     // dense — all 5 engines always present
  mixer: MixerState;
  playMode: 'mono' | 'chord';
  steps: Step[];                // length 16
}
```

With:

```ts
export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;     // dense — all 5 engines always present
  mixer: MixerState;
  steps: Step[];                // length 16
}
```

### Step 3.7: Remove `playMode` line from `freshTrack`

- [ ] **Step 3.7: Edit `src/project/factory.ts:26-40`**

Replace the `freshTrack` function body with:

```ts
export function freshTrack(): ProjectTrack {
  return {
    engineType: 'synth',
    engines: {
      synth: structuredClone(SynthEngine.DEFAULT_PARAMS),
      kick:  structuredClone(KickEngine.DEFAULT_PARAMS),
      hat:   structuredClone(HatEngine.DEFAULT_PARAMS),
      snare: structuredClone(SnareEngine.DEFAULT_PARAMS),
      clap:  structuredClone(ClapEngine.DEFAULT_PARAMS),
    },
    mixer: { ...DEFAULT_MIXER_STATE },
    steps: Array.from({ length: 16 }, () => freshStep()),
  };
}
```

### Step 3.8: Update factory test

- [ ] **Step 3.8: Edit `src/project/factory.test.ts`**

If `factory.test.ts` has an assertion like `expect(t.playMode).toBe('mono')`, delete the line. Add (or keep, from T1) `expect(t.engines.synth.mode).toBe('mono')`.

### Step 3.9: Drop `playMode` from reconciler output literal

- [ ] **Step 3.9: Edit `src/project/storage.ts:32-50`**

Replace `reconcileTrack` with:

```ts
function reconcileTrack(loaded: unknown): ProjectTrack {
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
    steps: reconcileSteps(t.steps, fresh.steps),
  };

  // Legacy compat: pre-refactor localStorage / .prj.json files stored
  // playMode on the track. The reconciler silently absorbs the old field
  // into synth.mode and drops it from the output.
  if ((t as any).playMode === 'chord') {
    reconciled.engines.synth.mode = 'poly';
  }

  return reconciled;
}
```

### Step 3.10: Drop `playMode` line from `replaceProject`

- [ ] **Step 3.10: Edit `src/project/storage.ts:137-158`**

Replace `replaceProject` with:

```ts
export function replaceProject(target: Project, source: Project): void {
  target.schemaVersion = source.schemaVersion;
  target.bpm = source.bpm;

  for (let i = 0; i < 4; i++) {
    const t = target.tracks[i];
    const s = source.tracks[i];

    t.engineType = s.engineType;

    for (const engine of ENGINE_KEYS) {
      Object.assign(t.engines[engine], s.engines[engine]);
    }

    Object.assign(t.mixer, s.mixer);

    for (let j = 0; j < 16; j++) {
      Object.assign(t.steps[j], s.steps[j]);
    }
  }
}
```

### Step 3.11: Update storage tests

- [ ] **Step 3.11: Edit `src/project/storage.test.ts`**

Search for any references to `playMode` in storage tests:

```bash
grep -n "playMode" src/project/storage.test.ts
```

For each existing test that asserts `track.playMode` on the reconciled output or in `replaceProject` fixtures, either:
- Replace the assertion with the equivalent `track.engines.synth.mode` check, OR
- Delete the assertion if it was about `playMode` field presence (the T2 "drops the legacy playMode field" test already covers absence).

The two T2 tests (`translates track.playMode === "chord" into track.engines.synth.mode === "poly"` and `drops the legacy playMode field from the reconciled track`) stay as-is.

### Step 3.12: Update Tracker.vue — remove toggle, rename prop

- [ ] **Step 3.12: Edit `src/components/Tracker.vue`**

**Delete lines 24-46** (the entire `<!-- Play Mode Selector -->` block including the wrapping `<div class="playmode-selector">`).

**Rename the prop** in the `defineProps` / props definition: find `playMode?: 'mono' | 'chord';` and replace with `mode?: 'mono' | 'poly';`. Find the default (`playMode: 'mono'`) in `withDefaults` and rename to `mode: 'mono'`.

**Remove the emit** for `update:playMode` from the `defineEmits` call.

**Update row-render branches**: search for `playMode === 'chord'` in the template — replace with `mode === 'poly'`. Search for `playMode === 'mono'` and replace with `mode === 'mono'` if present. The class names `synth-row` / `chord-row` keep their old names (they refer to row layout, not to the mode literal) — they're a stable CSS contract.

Run a final grep to confirm `playMode` is gone:

```bash
grep -n "playMode" src/components/Tracker.vue
```

**Expected:** no matches.

### Step 3.13: Update SynthPanel.vue — add mono/poly toggle

- [ ] **Step 3.13: Edit `src/components/SynthPanel.vue`**

Add a new `mode` v-model. Update the script and template as follows.

**Script** — add to the `defineModel` block:

```ts
const mode = defineModel<'mono' | 'poly'>('mode', { required: true });
```

**Template** — add a new mode-selector block at the very top of `.rack-columns`, before the first `.rack-column`:

```vue
<template>
  <div class="rack-columns">
    <!-- Mono/Poly toggle -->
    <div class="synth-mode-selector">
      <button
        type="button"
        class="mode-btn"
        :class="{ active: mode === 'mono' }"
        @click="mode = 'mono'"
      >
        MONO
      </button>
      <button
        type="button"
        class="mode-btn"
        :class="{ active: mode === 'poly' }"
        @click="mode = 'poly'"
      >
        POLY
      </button>
    </div>

    <!-- Column 1: Oscillators & Mixer -->
    <div class="rack-column">
      <!-- ... existing content unchanged ... -->
```

**Scoped style** — add to the existing `<style scoped>` block:

```css
.synth-mode-selector {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-bottom: 5px;
}
.synth-mode-selector .mode-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 6px 12px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.synth-mode-selector .mode-btn:hover {
  color: #aaa;
  border-color: #444;
}
.synth-mode-selector .mode-btn.active {
  background: #222;
  color: #fff;
  border-color: #555;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}
```

### Step 3.14: Update App.vue — Tracker + SynthPanel + import + handler bindings

- [ ] **Step 3.14: Edit `src/App.vue`**

**Tracker invocations (two of them, lines 24-39 overview and 96-108 focused)** — remove the `v-model:playMode="..."` line from both. Replace with `:mode="getTrackMode(index)"` for the overview block and `:mode="synthMode"` for the focused block, or even cleaner, pass a derived value. Concretely:

Overview Tracker (~lines 24-39):

```vue
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
  :mode="project.tracks[index].engines.synth.mode"
  @select-track="selectTrack(index)"
  @clear="onClear"
  @shift="onShift"
  @fill="onFill"
/>
```

Focused Tracker (~lines 96-108):

```vue
<Tracker
  :steps="project.tracks[activeTrackIndex].steps"
  :currentStep="currentStep"
  :title="`Track ${activeTrackIndex + 1}`"
  :color="TRACK_COLORS[activeTrackIndex]"
  :isFocused="true"
  :trackId="activeTrackIndex"
  :engineType="engineType"
  :mode="synthMode"
  @clear="onClear"
  @shift="onShift"
  @fill="onFill"
/>
```

**SynthPanel invocation (~lines 112-132)** — add `v-model:mode="synthMode"`:

```vue
<SynthPanel
  v-model:osc1Type="osc1Type"
  v-model:osc1Coarse="osc1Coarse"
  v-model:osc1Fine="osc1Fine"
  v-model:osc2Type="osc2Type"
  v-model:osc2Coarse="osc2Coarse"
  v-model:osc2Fine="osc2Fine"
  v-model:osc1Level="osc1Level"
  v-model:osc2Level="osc2Level"
  v-model:filterCutoff="filterCutoff"
  v-model:filterRes="filterRes"
  v-model:filterEnvAmount="filterEnvAmount"
  v-model:mode="synthMode"
  :waveforms="waveforms"
  :filterEnv="filterEnv"
  :ampEnv="ampEnv"
  :shortestActiveNoteDuration="shortestActiveNoteDuration"
  :analyser="analyser"
  :color="TRACK_COLORS[activeTrackIndex]"
/>
```

**Script — useSynth destructure (~line 207)** — add `synthMode` to the destructure between `engineType` and `osc1Type`:

```ts
const {
  project,
  analyser,
  sequencer,
  bpm,
  activeTrackIndex,
  currentStep,
  waveforms,
  engineType,
  synthMode,           // NEW
  osc1Type,
  osc2Type,
  // ... rest unchanged
```

Verify the file no longer references the old binding:

```bash
grep -n "playMode\|synthMode" src/App.vue
```

After the edits the only matches should be `synthMode`.

**Dead CSS cleanup in Tracker.vue:** the `.playmode-selector` block in the template was deleted in Step 3.12. Its `<style scoped>` rules (`.playmode-selector`, `.mode-btn`) are now dead. Find them with `grep -n "playmode-selector\|mode-btn" src/components/Tracker.vue` and delete the corresponding rules.

### Step 3.15: Run full gates

- [ ] **Step 3.15**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** all tests pass (count unchanged from T2 — 146 — modulo any tests that referenced removed `playMode` and were updated in 3.5/3.8/3.11). `vue-tsc` clean. `vite build` clean.

### Step 3.16: Browser smoke check (developer)

- [ ] **Step 3.16**

```bash
npm run dev
```

In the browser:
- Open the focused view of track 1. The SynthPanel shows MONO/POLY at the top. Tracker no longer shows the MONO/CHORD toggle.
- Click POLY → step-grid rendering switches to chord rows (CHORD column visible). MONO returns to single-note rows.
- Stop the dev server.

This is a developer-only check, not gated by tests, but catches v-model misbindings early.

### Step 3.17: Commit

- [ ] **Step 3.17**

```bash
git add src/composables/useSynth.ts src/composables/useSynth.test.ts \
        src/project/types.ts src/project/factory.ts src/project/factory.test.ts \
        src/project/storage.ts src/project/storage.test.ts \
        src/components/Tracker.vue src/components/SynthPanel.vue \
        src/App.vue
git commit -m "refactor(project): move playMode onto synth engine as mode: mono|poly

The sequencer now reads track.engines.synth.mode (renamed 'chord' →
'poly'). ProjectTrack.playMode is gone from the type, freshTrack, and
replaceProject. useSynth exposes synthMode (writable computed against
the active track's synth.mode). The MONO/POLY toggle moved out of
Tracker.vue (it only ever mattered for synth tracks) into SynthPanel,
where it lives alongside the rest of the synth controls. Tracker still
receives mode as a prop for its row-rendering branch.

Reconciler keeps the legacy playMode compat read added in T2, so the
developer's existing localStorage and any prior .json saves survive."
```

### Step 3.18: Merge

- [ ] **Step 3.18**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/playmode-refactor-cutover -m "Merge T3: playMode refactor cutover"
```

---

## Task 4: NEW button + handler

**Sub-branch:** `task/new-project-button`

**Files:**
- Modify: `src/App.vue` (header transport: add `<button @click="onNew">NEW</button>`; script: add `onNew` handler)
- Test: `src/App.test.ts` if it exists; if not, this is a UI-only addition verifiable in the browser.

### Step 4.1: Create sub-branch

- [ ] **Step 4.1**

```bash
git checkout -b task/new-project-button
```

### Step 4.2: Check for existing App.vue test

- [ ] **Step 4.2**

```bash
ls src/App.test.* 2>/dev/null
grep -rn "@vue/test-utils" src/ 2>/dev/null
```

**Expected:** likely no results. App.vue is not unit-tested at the component-mount level; useSynth has its own tests. If a file exists, add a `confirm()`-mocked test (template in 4.3). Otherwise skip the test and rely on browser verification + the existing handler-logic invariants.

### Step 4.3: (Conditional) Add a confirm-mocked test

- [ ] **Step 4.3: Only if `src/App.test.*` exists; otherwise skip to 4.4**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// ... mount setup specific to whatever test harness is used

describe('App — NEW button', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resets project to defaults when user confirms', async () => {
    // mount App, set project.bpm = 99, click NEW button, expect project.bpm === 120
  });

  it('leaves project alone when user cancels', async () => {
    (globalThis.confirm as any).mockReturnValue(false);
    // ... same setup, expect project.bpm === 99 after click
  });
});
```

(If you skipped this step, the handler-logic correctness is covered by `replaceProject` and `freshProject` tests already in place.)

### Step 4.4: Add the NEW button to the header

- [ ] **Step 4.4: Edit `src/App.vue` template — `.transport` div**

Locate the `<div class="transport">` block in the header (~lines 8-19). Insert the NEW button between PLAY and SAVE:

```vue
<div class="transport">
  <button @click="togglePlay" :class="{ playing: sequencer.isPlaying }">
    {{ sequencer.isPlaying ? 'STOP' : 'PLAY' }}
  </button>
  <div class="bpm">
    <label>BPM</label>
    <input type="number" v-model.number="bpm" min="40" max="240">
  </div>
  <button @click="onNew" title="Discard current project and start fresh">NEW</button>
  <button @click="onSave" title="Save project to a file">SAVE</button>
  <button @click="onOpen" title="Open a project from a file">OPEN</button>
</div>
```

### Step 4.5: Add the handler + imports

- [ ] **Step 4.5: Edit `src/App.vue` `<script setup>` block**

Update the import from `'./project'` to include `freshProject`:

```ts
import {
  clearTrack as clearProjectTrack,
  shiftTrack as shiftProjectTrack,
  fillTrack  as fillProjectTrack,
  saveProjectToFile,
  openProjectFromFile,
  replaceProject,
  freshProject,                   // NEW
} from './project';
```

Then add the handler near the other `onSave` / `onOpen` handlers:

```ts
const onNew = () => {
  if (confirm('Discard current project and start fresh?')) {
    replaceProject(project, freshProject());
  }
};
```

### Step 4.6: Run gates

- [ ] **Step 4.6**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** test count unchanged (or +2 if the conditional test in 4.3 was added). All green. `vue-tsc` clean. `vite build` clean.

### Step 4.7: Browser smoke check

- [ ] **Step 4.7**

```bash
npm run dev
```

In the browser:
- Twirl a few knobs / lay down a few steps.
- Click NEW. Confirm prompt appears: "Discard current project and start fresh?"
- OK → project resets to defaults (synth engines, no steps lit).
- Twirl knobs again. Click NEW. Cancel → nothing changes.
- Stop the dev server.

### Step 4.8: Commit

- [ ] **Step 4.8**

```bash
git add src/App.vue
git commit -m "feat(app): NEW button with confirm prompt

Adds a NEW button to the header transport, between PLAY and SAVE.
Handler shows a native confirm() dialog ('Discard current project
and start fresh?'); on OK, replaces project in place via
replaceProject(project, freshProject()). Auto-save then propagates
the reset to localStorage."
```

### Step 4.9: Merge

- [ ] **Step 4.9**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/new-project-button -m "Merge T4: NEW button"
```

---

## Task 5: `preset.ts` data module

**Sub-branch:** `task/preset-module`

**Files:**
- Create: `src/project/preset.ts`
- Create: `src/project/preset.test.ts`
- Modify: `src/project/index.ts` (re-export)

### Step 5.1: Create sub-branch

- [ ] **Step 5.1**

```bash
git checkout -b task/preset-module
```

### Step 5.2: Write the failing test file

- [ ] **Step 5.2: Create `src/project/preset.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  makePreset,
  serializePreset,
  deserializePreset,
  applyPreset,
  PRESET_SCHEMA_VERSION,
  type Preset,
} from './preset';
import { freshTrack } from './factory';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';

describe('preset — makePreset', () => {
  it('builds a Preset with schemaVersion + engineType + cloned params', () => {
    const params = { ...SynthEngine.DEFAULT_PARAMS, filterCutoff: 1234 };
    const preset = makePreset('synth', params);
    expect(preset.schemaVersion).toBe(PRESET_SCHEMA_VERSION);
    expect(preset.engineType).toBe('synth');
    expect((preset.params as typeof params).filterCutoff).toBe(1234);
  });

  it('clones params (mutating the input does not affect the preset)', () => {
    const params = { ...SynthEngine.DEFAULT_PARAMS };
    const preset = makePreset('synth', params);
    params.filterCutoff = 9999;
    expect((preset.params as typeof params).filterCutoff).toBe(SynthEngine.DEFAULT_PARAMS.filterCutoff);
  });
});

describe('preset — serialize/deserialize round-trip', () => {
  it('round-trips a synth preset', () => {
    const params = { ...SynthEngine.DEFAULT_PARAMS, filterCutoff: 1500, mode: 'poly' as const };
    const preset = makePreset('synth', params);
    const json = serializePreset(preset);
    const restored = deserializePreset(json);
    expect(restored.engineType).toBe('synth');
    expect((restored.params as typeof params).filterCutoff).toBe(1500);
    expect((restored.params as typeof params).mode).toBe('poly');
  });

  it('round-trips a kick preset', () => {
    const params = { ...KickEngine.DEFAULT_PARAMS, tune: 42 };
    const preset = makePreset('kick', params);
    const restored = deserializePreset(serializePreset(preset));
    expect(restored.engineType).toBe('kick');
    expect((restored.params as typeof params).tune).toBe(42);
  });

  it('fills missing fields from engine DEFAULT_PARAMS (forward-compat)', () => {
    // Older preset file written before some new synth param existed.
    const partial = JSON.stringify({
      schemaVersion: 1,
      engineType: 'synth',
      params: { filterCutoff: 1200 },
    });
    const restored = deserializePreset(partial);
    expect((restored.params as any).filterCutoff).toBe(1200);
    // Defaults filled for everything else
    expect((restored.params as any).osc1Type).toBe(SynthEngine.DEFAULT_PARAMS.osc1Type);
    expect((restored.params as any).mode).toBe(SynthEngine.DEFAULT_PARAMS.mode);
  });

  it('throws on malformed JSON', () => {
    expect(() => deserializePreset('{ not json')).toThrow();
  });

  it('throws on unknown engineType', () => {
    const bad = JSON.stringify({ schemaVersion: 1, engineType: 'theremin', params: {} });
    expect(() => deserializePreset(bad)).toThrow();
  });
});

describe('preset — applyPreset', () => {
  it('preserves track reference identity', () => {
    const track = freshTrack();
    const before = track;
    applyPreset(track, makePreset('synth', { ...SynthEngine.DEFAULT_PARAMS, filterCutoff: 4444 }));
    expect(track).toBe(before);
  });

  it('writes engineType + the matching engine slice; leaves other engines untouched', () => {
    const track = freshTrack();
    track.engines.kick.tune = 88;          // pretend the user customized kick
    track.engines.synth.filterCutoff = 1111;
    expect(track.engineType).toBe('synth');

    applyPreset(track, makePreset('kick', { ...KickEngine.DEFAULT_PARAMS, tune: 22 }));
    expect(track.engineType).toBe('kick');
    expect(track.engines.kick.tune).toBe(22);
    // Synth slice on this track is preserved — the user can toggle back and get filterCutoff=1111
    expect(track.engines.synth.filterCutoff).toBe(1111);
  });

  it('leaves mixer + steps untouched', () => {
    const track = freshTrack();
    track.mixer.volume = 0.42;
    track.steps[0].note = 'C';

    applyPreset(track, makePreset('hat', { decay: 0.99, tone: 5000, metallic: 0.1 } as any));
    expect(track.mixer.volume).toBe(0.42);
    expect(track.steps[0].note).toBe('C');
  });
});
```

### Step 5.3: Run, verify fail

- [ ] **Step 5.3**

```bash
npx vitest run src/project/preset.test.ts
```

**Expected:** all preset tests fail with import errors (`Cannot find module './preset'`).

### Step 5.4: Implement `preset.ts`

- [ ] **Step 5.4: Create `src/project/preset.ts`**

```ts
import { deepMerge } from '../utils/deepMerge';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import type {
  EngineType,
  EngineParamsMap,
  ProjectTrack,
} from './types';

export const PRESET_SCHEMA_VERSION = 1 as const;

export interface Preset {
  schemaVersion: typeof PRESET_SCHEMA_VERSION;
  engineType: EngineType;
  params: EngineParamsMap[EngineType];
}

// Build a Preset from a known (engineType, params) pair. Clones the params
// so subsequent edits to the caller's object don't bleed into the preset.
export function makePreset<T extends EngineType>(
  engineType: T,
  params: EngineParamsMap[T],
): Preset {
  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    engineType,
    params: structuredClone(params) as EngineParamsMap[EngineType],
  };
}

const DEFAULTS: { [K in EngineType]: EngineParamsMap[K] } = {
  synth: SynthEngine.DEFAULT_PARAMS,
  kick:  KickEngine.DEFAULT_PARAMS,
  hat:   HatEngine.DEFAULT_PARAMS,
  snare: SnareEngine.DEFAULT_PARAMS,
  clap:  ClapEngine.DEFAULT_PARAMS,
};

const ALL_ENGINE_TYPES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap'];

function isEngineType(s: unknown): s is EngineType {
  return typeof s === 'string' && (ALL_ENGINE_TYPES as string[]).includes(s);
}

export function serializePreset(preset: Preset): string {
  return JSON.stringify(preset);
}

// Inverse of serializePreset. Throws on truly unrecoverable input
// (malformed JSON, unknown engineType, missing engineType). Reconciles
// missing params against the engine's DEFAULT_PARAMS so older preset
// files with fewer fields load cleanly.
export function deserializePreset(text: string): Preset {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Preset JSON parse failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Preset root is not an object');
  }

  if (!isEngineType(parsed.engineType)) {
    throw new Error(`Unknown engineType: ${JSON.stringify(parsed.engineType)}`);
  }

  const engineType = parsed.engineType as EngineType;
  const params = deepMerge(DEFAULTS[engineType], parsed.params) as EngineParamsMap[EngineType];

  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    engineType,
    params,
  };
}

// Mutate `track` in place to take on the preset's engine + params.
// Leaves track.mixer, track.steps, and the other-engines' params on
// this track untouched. Preserves the track reference identity, so
// installed Vue watchers on `track` keep firing.
export function applyPreset(track: ProjectTrack, preset: Preset): void {
  track.engineType = preset.engineType;
  Object.assign(
    track.engines[preset.engineType] as Record<string, unknown>,
    preset.params as Record<string, unknown>,
  );
}
```

### Step 5.5: Re-export from index

- [ ] **Step 5.5: Edit `src/project/index.ts`**

Add to the existing exports:

```ts
export {
  PRESET_SCHEMA_VERSION,
  makePreset,
  serializePreset,
  deserializePreset,
  applyPreset,
  type Preset,
} from './preset';
```

### Step 5.6: Run preset tests

- [ ] **Step 5.6**

```bash
npx vitest run src/project/preset.test.ts
```

**Expected:** all preset tests pass.

### Step 5.7: Run full gates

- [ ] **Step 5.7**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** all tests pass (146 + the new preset tests). `vue-tsc` clean. `vite build` clean.

### Step 5.8: Commit

- [ ] **Step 5.8**

```bash
git add src/project/preset.ts src/project/preset.test.ts src/project/index.ts
git commit -m "feat(project): preset.ts — engine preset type + applyPreset

A Preset is { schemaVersion, engineType, params } — a single engine's
choice and its full param set. makePreset clones, serializePreset is
JSON.stringify, deserializePreset throws on malformed JSON / unknown
engineType and reconciles missing params against the engine's
DEFAULT_PARAMS for forward-compat.

applyPreset(track, preset) mutates in place: sets track.engineType,
Object.assigns preset.params into the matching engine slice. Other
engines on the track, the mixer, and the steps stay untouched —
toggling back to the previously-active engine restores its prior
params (dense ProjectTrack model)."
```

### Step 5.9: Merge

- [ ] **Step 5.9**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/preset-module -m "Merge T5: preset.ts data module"
```

---

## Task 6: `preset-file-io.ts` file I/O module

**Sub-branch:** `task/preset-file-io`

**Files:**
- Create: `src/project/preset-file-io.ts`
- Create: `src/project/preset-file-io.test.ts` (first line `// @vitest-environment jsdom`)
- Modify: `src/project/index.ts` (re-export)

### Step 6.1: Create sub-branch

- [ ] **Step 6.1**

```bash
git checkout -b task/preset-file-io
```

### Step 6.2: Write the failing test file

- [ ] **Step 6.2: Create `src/project/preset-file-io.test.ts`**

```ts
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  savePresetToFile,
  openPresetFromFile,
  PresetFileError,
} from './preset-file-io';
import { makePreset } from './preset';
import { SynthEngine } from '../engine/SynthEngine';

describe('savePresetToFile — native picker path', () => {
  let writeMock: ReturnType<typeof vi.fn>;
  let closeMock: ReturnType<typeof vi.fn>;
  let pickerMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeMock = vi.fn().mockResolvedValue(undefined);
    closeMock = vi.fn().mockResolvedValue(undefined);
    const handle = {
      createWritable: vi.fn().mockResolvedValue({ write: writeMock, close: closeMock }),
    };
    pickerMock = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal('showSaveFilePicker', pickerMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls showSaveFilePicker with .chnl.json filter and writes the serialized preset', async () => {
    const preset = makePreset('synth', SynthEngine.DEFAULT_PARAMS);
    await savePresetToFile(preset);
    expect(pickerMock).toHaveBeenCalledTimes(1);
    const call = pickerMock.mock.calls[0][0];
    expect(call.types[0].accept).toEqual({ 'application/json': ['.chnl.json'] });
    expect(call.suggestedName).toBe('synth-preset.chnl.json');
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = writeMock.mock.calls[0][0];
    expect(JSON.parse(written).engineType).toBe('synth');
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('silently no-ops on user-cancellation (AbortError)', async () => {
    pickerMock.mockRejectedValue(new DOMException('User cancelled', 'AbortError'));
    const preset = makePreset('kick', { ...SynthEngine.DEFAULT_PARAMS } as any);
    await expect(savePresetToFile(preset)).resolves.toBeUndefined();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('throws PresetFileError on a non-abort failure', async () => {
    pickerMock.mockRejectedValue(new Error('permission denied'));
    const preset = makePreset('synth', SynthEngine.DEFAULT_PARAMS);
    await expect(savePresetToFile(preset)).rejects.toBeInstanceOf(PresetFileError);
  });
});

describe('savePresetToFile — fallback download anchor', () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let anchorClick: ReturnType<typeof vi.fn>;
  let anchorRemove: ReturnType<typeof vi.fn>;
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('showSaveFilePicker', undefined);
    anchorClick = vi.fn();
    anchorRemove = vi.fn();
    const realCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as any;
      if (tag === 'a') {
        el.click = anchorClick;
        el.remove = anchorRemove;
      }
      return el;
    });
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    createElementSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it('creates a download anchor when native picker is unavailable', async () => {
    const preset = makePreset('snare', { tune: 200, decay: 0.3, snappy: 0.5 } as any);
    await savePresetToFile(preset);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(anchorRemove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fake');
  });
});

describe('openPresetFromFile — native picker path', () => {
  let pickerMock: ReturnType<typeof vi.fn>;
  let fileText: string;

  beforeEach(() => {
    fileText = JSON.stringify({
      schemaVersion: 1,
      engineType: 'kick',
      params: { tune: 42, decay: 0.2, click: 0.3 },
    });
    const file = { text: vi.fn().mockResolvedValue(fileText) };
    const handle = { getFile: vi.fn().mockResolvedValue(file) };
    pickerMock = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', pickerMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed preset', async () => {
    const preset = await openPresetFromFile();
    expect(preset).not.toBeNull();
    expect(preset!.engineType).toBe('kick');
    expect((preset!.params as any).tune).toBe(42);
  });

  it('returns null on AbortError (user cancellation)', async () => {
    pickerMock.mockRejectedValue(new DOMException('cancel', 'AbortError'));
    expect(await openPresetFromFile()).toBeNull();
  });

  it('throws PresetFileError on a corrupted file', async () => {
    const file = { text: vi.fn().mockResolvedValue('not json') };
    const handle = { getFile: vi.fn().mockResolvedValue(file) };
    pickerMock.mockResolvedValue([handle]);
    await expect(openPresetFromFile()).rejects.toBeInstanceOf(PresetFileError);
  });
});

describe('openPresetFromFile — fallback input', () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let inputClick: ReturnType<typeof vi.fn>;
  let inputListeners: Record<string, EventListener>;

  beforeEach(() => {
    vi.stubGlobal('showOpenFilePicker', undefined);
    inputClick = vi.fn();
    inputListeners = {};
    const realCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as any;
      if (tag === 'input') {
        el.click = inputClick;
        el.addEventListener = (type: string, l: EventListener) => { inputListeners[type] = l; };
        el.removeEventListener = vi.fn();
      }
      return el;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    createElementSpy.mockRestore();
  });

  it('resolves with the parsed preset on change event', async () => {
    const promise = openPresetFromFile();
    // Simulate user picking a file
    const fakeFile = new Blob([JSON.stringify({
      schemaVersion: 1,
      engineType: 'hat',
      params: { decay: 0.2, tone: 6000, metallic: 0.7 },
    })], { type: 'application/json' });
    Object.defineProperty(fakeFile, 'text', { value: () => Promise.resolve(JSON.stringify({
      schemaVersion: 1,
      engineType: 'hat',
      params: { decay: 0.2, tone: 6000, metallic: 0.7 },
    })) });
    // Find the input element that was created; attach files property via the listener
    expect(inputClick).toHaveBeenCalled();
    // Trigger the change handler with files attached
    const input = createElementSpy.mock.results.at(-1)!.value as any;
    Object.defineProperty(input, 'files', { value: [fakeFile] });
    inputListeners['change']!(new Event('change'));
    const result = await promise;
    expect(result!.engineType).toBe('hat');
  });

  it('resolves null on cancel event', async () => {
    const promise = openPresetFromFile();
    inputListeners['cancel']!(new Event('cancel'));
    expect(await promise).toBeNull();
  });
});
```

### Step 6.3: Run, verify fail

- [ ] **Step 6.3**

```bash
npx vitest run src/project/preset-file-io.test.ts
```

**Expected:** import error for `./preset-file-io` (module does not exist).

### Step 6.4: Implement `preset-file-io.ts`

- [ ] **Step 6.4: Create `src/project/preset-file-io.ts`**

```ts
import type { Preset } from './preset';
import { serializePreset, deserializePreset } from './preset';

export class PresetFileError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PresetFileError';
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

// Save a preset to disk. Native File System Access API on Chrome/Edge;
// download-anchor fallback on Safari/Firefox. User cancellation is silent.
export async function savePresetToFile(
  preset: Preset,
  suggestedName: string = `${preset.engineType}-preset.chnl.json`,
): Promise<void> {
  const json = serializePreset(preset);

  const picker = (globalThis as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName,
        types: [{
          description: 'Fiddle preset',
          accept: { 'application/json': ['.chnl.json'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (e) {
      if (isAbortError(e)) return;
      throw new PresetFileError(
        `Failed to save preset: ${e instanceof Error ? e.message : 'unknown error'}`,
        e,
      );
    }
  }

  // Fallback — programmatic download
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Open a preset from disk. Native picker where available, hidden <input>
// fallback otherwise. Returns null if the user cancels. Throws
// PresetFileError for unreadable / corrupt files.
export async function openPresetFromFile(): Promise<Preset | null> {
  const picker = (globalThis as any).showOpenFilePicker;
  if (typeof picker === 'function') {
    let handles: any[];
    try {
      handles = await picker({
        types: [{
          description: 'Fiddle preset',
          accept: { 'application/json': ['.chnl.json'] },
        }],
        multiple: false,
      });
    } catch (e) {
      if (isAbortError(e)) return null;
      throw new PresetFileError(
        `Failed to open preset: ${e instanceof Error ? e.message : 'unknown error'}`,
        e,
      );
    }
    const file = await handles[0].getFile();
    const text = await file.text();
    return parseOrWrap(text);
  }

  const file = await pickFileViaInput();
  if (file === null) return null;
  const text = await file.text();
  return parseOrWrap(text);
}

function parseOrWrap(text: string): Preset {
  try {
    return deserializePreset(text);
  } catch (e) {
    throw new PresetFileError(
      `Could not load preset: ${e instanceof Error ? e.message : 'unknown error'}`,
      e,
    );
  }
}

function pickFileViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.chnl.json';
    input.style.display = 'none';

    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const onChange = () => {
      const file = input.files && input.files.length > 0 ? input.files[0] : null;
      cleanup();
      resolve(file);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    document.body.appendChild(input);
    input.click();
  });
}
```

### Step 6.5: Re-export from index

- [ ] **Step 6.5: Edit `src/project/index.ts`**

Add to existing exports:

```ts
export {
  savePresetToFile,
  openPresetFromFile,
  PresetFileError,
} from './preset-file-io';
```

### Step 6.6: Run preset-file-io tests

- [ ] **Step 6.6**

```bash
npx vitest run src/project/preset-file-io.test.ts
```

**Expected:** all preset-file-io tests pass. (If a single test for the fallback `<input>` flow is flaky on jsdom event timing, see project's existing `file-io.test.ts` for the working pattern — the structure used here mirrors it.)

### Step 6.7: Run full gates

- [ ] **Step 6.7**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** all tests pass. `vue-tsc` clean. `vite build` clean.

### Step 6.8: Commit

- [ ] **Step 6.8**

```bash
git add src/project/preset-file-io.ts src/project/preset-file-io.test.ts src/project/index.ts
git commit -m "feat(project): preset-file-io.ts — save/open .chnl.json presets

Mirrors file-io.ts for projects: File System Access API where
available, download-anchor / <input type=file> fallbacks otherwise.
Default suggested filename is <engineType>-preset.chnl.json. Picker
accept filter is .chnl.json only (distinct from project's .prj.json).
User cancellation is silent on both paths. Bad-file throws
PresetFileError for the caller to surface."
```

### Step 6.9: Merge

- [ ] **Step 6.9**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/preset-file-io -m "Merge T6: preset-file-io.ts"
```

---

## Task 7: Project file extension `.json` → `.prj.json`

**Sub-branch:** `task/prj-json-extension`

**Files:**
- Modify: `src/project/file-io.ts` (default `suggestedName`; picker filters; input accept)
- Modify: `src/project/file-io.test.ts` (expectation updates)

### Step 7.1: Create sub-branch

- [ ] **Step 7.1**

```bash
git checkout -b task/prj-json-extension
```

### Step 7.2: Update `file-io.ts` save default + filters

- [ ] **Step 7.2: Edit `src/project/file-io.ts`**

Replace the function signature default on `saveProjectToFile`:

```ts
export async function saveProjectToFile(
  project: Project,
  suggestedName: string = 'fiddle-project.prj.json',
): Promise<void> {
```

Inside `saveProjectToFile`, update the picker's `types`:

```ts
types: [{
  description: 'Fiddle project',
  accept: { 'application/json': ['.json', '.prj.json'] },
}],
```

Inside `openProjectFromFile`, update the same `types` literal:

```ts
types: [{
  description: 'Fiddle project',
  accept: { 'application/json': ['.json', '.prj.json'] },
}],
```

Inside `pickFileViaInput`, update the `input.accept`:

```ts
input.accept = 'application/json,.json,.prj.json';
```

### Step 7.3: Update `file-io.test.ts` expectations

- [ ] **Step 7.3: Edit `src/project/file-io.test.ts`**

Search for any expectations referencing the old default or accept list:

```bash
grep -n "fiddle-project.json\|'.json'\]\|application/json,.json" src/project/file-io.test.ts
```

Update:
- Any assertion of `suggestedName === 'fiddle-project.json'` → `'fiddle-project.prj.json'`.
- Any assertion of `accept: { 'application/json': ['.json'] }` → `accept: { 'application/json': ['.json', '.prj.json'] }`.
- The `<input>` accept assertion if present.

### Step 7.4: Run gates

- [ ] **Step 7.4**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** all tests pass. `vue-tsc` clean. `vite build` clean.

### Step 7.5: Commit

- [ ] **Step 7.5**

```bash
git add src/project/file-io.ts src/project/file-io.test.ts
git commit -m "feat(project): project file extension .json → .prj.json

Saves now default to fiddle-project.prj.json. Open picker accepts
both .json (legacy, developer's own files from before this branch)
and .prj.json (new). The <input> fallback accepts both as well.
Sister to T6 .chnl.json presets — the two file types are now
visually distinguishable in a directory listing."
```

### Step 7.6: Merge

- [ ] **Step 7.6**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/prj-json-extension -m "Merge T7: .prj.json extension"
```

---

## Task 8: SAVE PRESET / LOAD PRESET buttons + ARCHITECTURE doc

**Sub-branch:** `task/preset-ui-and-docs`

**Files:**
- Modify: `src/App.vue` (focused-view-header: add preset controls; script: import preset API + add handlers)
- Modify: `docs/ARCHITECTURE.md` (extend §13 with preset paragraph)

### Step 8.1: Create sub-branch

- [ ] **Step 8.1**

```bash
git checkout -b task/preset-ui-and-docs
```

### Step 8.2: Add SAVE PRESET / LOAD PRESET buttons to `.focused-view-header`

- [ ] **Step 8.2: Edit `src/App.vue` template**

Locate the `.focused-view-header` div (~lines 44-90). After the existing `.engine-selector` div, add a new `.preset-controls` div:

```vue
<div class="focused-view-header">
  <button class="back-btn" @click="selectTrack(null)">
    ← BACK TO OVERVIEW
  </button>
  <h2 :style="{ color: TRACK_COLORS[activeTrackIndex] }">
    Editing: Track {{ activeTrackIndex + 1 }} ({{ engineType.toUpperCase() }})
  </h2>

  <div class="engine-selector">
    <!-- ... existing engine selector buttons unchanged ... -->
  </div>

  <div class="preset-controls">
    <button @click="onSavePreset" title="Save the current engine + its params as a preset">SAVE PRESET</button>
    <button @click="onLoadPreset" title="Load a preset onto this track">LOAD PRESET</button>
  </div>
</div>
```

### Step 8.3: Update App.vue script imports + handlers

- [ ] **Step 8.3: Edit `src/App.vue` `<script setup>`**

Update the `./project` import block to include preset API:

```ts
import {
  clearTrack as clearProjectTrack,
  shiftTrack as shiftProjectTrack,
  fillTrack  as fillProjectTrack,
  saveProjectToFile,
  openProjectFromFile,
  replaceProject,
  freshProject,
  makePreset,
  savePresetToFile,
  openPresetFromFile,
  applyPreset,
} from './project';
```

Add the handlers below the existing `onNew` / `onSave` / `onOpen`:

```ts
const onSavePreset = () => {
  if (activeTrackIndex.value === null) return;
  const track = project.tracks[activeTrackIndex.value];
  const preset = makePreset(track.engineType, track.engines[track.engineType] as any);
  savePresetToFile(preset);
};

const onLoadPreset = async () => {
  if (activeTrackIndex.value === null) return;
  try {
    const preset = await openPresetFromFile();
    if (preset) applyPreset(project.tracks[activeTrackIndex.value], preset);
  } catch (e) {
    console.warn('Load preset failed:', e);
    alert(`Could not load preset: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};
```

### Step 8.4: Add `.preset-controls` scoped styles

- [ ] **Step 8.4: Edit `src/App.vue` `<style scoped>` block**

Add near the existing `.engine-selector` styles:

```css
.preset-controls {
  display: flex;
  gap: 10px;
}
.preset-controls button {
  background: #181818;
  color: #888;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px 16px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.preset-controls button:hover {
  background: #252525;
  color: #fff;
  border-color: #555;
}
```

### Step 8.5: Update ARCHITECTURE.md §13

- [ ] **Step 8.5: Edit `docs/ARCHITECTURE.md`**

Find `§13` (Project module / file I/O). Append a new paragraph after the existing file I/O paragraph:

```markdown
**Engine presets.** A preset is a single engine's choice + its full param
set, serialized as a `.chnl.json` file. Distinct from `.prj.json` project
files (which capture the whole 4-track project + BPM + steps).
`src/project/preset.ts` defines the `Preset` type, `makePreset` factory,
`serializePreset` / `deserializePreset`, and `applyPreset(track, preset)`
which mutates a track in place — sets `engineType`, `Object.assign`s
`params` into the matching engine slice, and leaves the other engines on
that track, the mixer, and the steps untouched (so toggling back to a
previously-active engine restores its prior params). File I/O lives in
`src/project/preset-file-io.ts` and follows the same picker + fallback
pattern as project save/open.
```

If §13 also documents the schema-versioning policy, add a sentence noting that presets carry their own `PRESET_SCHEMA_VERSION` (currently `1`), independent from `PROJECT_SCHEMA_VERSION`.

### Step 8.6: Run gates

- [ ] **Step 8.6**

```bash
npm test
npx vue-tsc --noEmit
npm run build
```

**Expected:** all tests pass. `vue-tsc` clean. `vite build` clean.

### Step 8.7: Browser smoke check

- [ ] **Step 8.7**

```bash
npm run dev
```

In the browser:
- Open track 1's focused view. Twirl filterCutoff, set mode to POLY. Click SAVE PRESET. Pick a folder, file saves as `synth-preset.chnl.json`.
- Click NEW (with confirm) to reset.
- Open track 1 again. Click LOAD PRESET. Select the file. Synth params restore, mode is POLY.
- Open track 2 (currently SYNTH). Switch to KICK, twirl tune to 88, click SAVE PRESET → kick-preset.chnl.json.
- On track 3, click LOAD PRESET, pick the kick preset. Track 3 switches to KICK with tune=88.
- Toggle track 3 back to SYNTH — synth params on track 3 are still the defaults (proves other-engine preservation).
- Cancel the SAVE PRESET picker → silent no-op.
- Try LOAD PRESET on a file with random text inside — alert appears with the friendly error message.

Stop the dev server.

### Step 8.8: Commit

- [ ] **Step 8.8**

```bash
git add src/App.vue docs/ARCHITECTURE.md
git commit -m "feat(app): SAVE PRESET / LOAD PRESET buttons + docs

Adds preset controls to the focused track header, alongside the
engine selector. Buttons act on the active track's currently-selected
engine. Save serializes the engine + params to a .chnl.json file;
load applies the preset in place via applyPreset, preserving other
engines / mixer / steps. Errors during load surface as a native
alert.

Documents the preset module + .chnl.json convention in
docs/ARCHITECTURE.md §13."
```

### Step 8.9: Merge

- [ ] **Step 8.9**

```bash
git checkout feature/init-and-presets
git merge --no-ff task/preset-ui-and-docs -m "Merge T8: preset UI + docs"
git log --oneline | head -20
```

**Expected:** 8 merge commits since `5bdffcb`, all tests still passing.

---

## Final acceptance verification

Run on `feature/init-and-presets` after T8 merges:

```bash
git status                          # clean
npm test                            # all green (155+ tests expected)
npx vue-tsc --noEmit                # clean
npm run build                       # clean
git log --oneline 5bdffcb..HEAD     # 1 spec commit + 8 task merges + 8 task commits
```

Then map each spec acceptance criterion (§12 in `docs/superpowers/specs/2026-05-24-init-and-presets-design.md`) to a verifying mechanism:

1. ✓ `SynthEngineParams.mode` exists with default `'mono'` — **T1 tests**
2. ✓ `ProjectTrack` no longer has `playMode` — **T3 (type compile + storage tests)**
3. ✓ Reconciler legacy compat read — **T2 tests**
4. ✓ `preset.ts` exports — **T5 tests + index.ts re-export**
5. ✓ `preset-file-io.ts` exports — **T6 tests + index.ts re-export**
6. ✓ Re-exports from `src/project/index.ts` — **T5/T6 tests verify via import paths**
7. ✓ NEW button + SAVE PRESET / LOAD PRESET buttons in App.vue — **T4 + T8 browser smoke**
8. ✓ Mono/Poly toggle in SynthPanel — **T3 browser smoke**
9. ✓ Project picker accepts both `.json` and `.prj.json` — **T7 tests**
10. ✓ Preset picker accepts and suggests `.chnl.json` — **T6 tests**
11. ✓ Cross-engine preset preservation — **T5 applyPreset test (preserves other engines)**
12. ✓ All existing tests pass; new tests added; `vue-tsc` + `vite build` clean — **gates at each task**
13. ✓ ARCHITECTURE.md §13 updated — **T8**

If any criterion is unverified, add the missing check before declaring the branch done.

---

## Hand-off

After all 8 tasks merge into `feature/init-and-presets` with gates passing:

1. Report total commits, files changed, test count to the user.
2. Browser verification owed by the user:
   - NEW button (confirm + cancel paths)
   - Save a synth preset (Chrome native picker + Safari download fallback)
   - Load that preset onto a different track; verify other engines on that track preserved
   - Load a corrupted `.chnl.json` (random bytes) → friendly alert
   - Open an old `.json` project file (from before T7) — still works
3. Merge to `main` is strictly user-gated. Same convention as `feature/project-model`: user calls "merge and push" when ready.
