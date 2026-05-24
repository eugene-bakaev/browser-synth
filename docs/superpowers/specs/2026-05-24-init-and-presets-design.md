# Init New Project + Engine Presets + `playMode` Refactor — Design

**Status:** Draft, awaiting user review.
**Branch:** `feature/init-and-presets` (no merge to `main` until user approves the combined branch).
**Builds on:** `docs/superpowers/specs/2026-05-23-project-model-design.md`, `docs/superpowers/specs/2026-05-24-project-file-io-design.md`.

## 1. Goals

- **Init new project.** A `NEW` button in the header resets all four tracks to defaults (after a `confirm()` prompt). Same semantics as `replaceProject(project, freshProject())`.
- **Save/load engine presets.** A preset captures one engine's choice + its params (e.g. "this synth patch", "this kick sound"). Save to a `.chnl.json` file; load applies the preset to the active track's current engine slot without disturbing other engines, the mixer, the steps, or the play mode of other tracks.
- **Refactor `playMode` onto the synth engine.** Currently `playMode` lives on `ProjectTrack` and is only ever read for synth tracks. Move it into `SynthEngineParams` as `mode: 'mono' | 'poly'`. This:
  - Drops a useless field from drum tracks.
  - Makes synth presets naturally carry their intended play mode (a pad preset arrives in `poly`, a bass preset arrives in `mono`).
  - Aligns with the "engine owns its params" pattern established by `DEFAULT_PARAMS`.

## 2. Non-goals

- **No preset library / browser UI.** The OS file picker is the library. No in-app list, rename, or delete.
- **No bulk import/export of presets.** One preset per file.
- **No factory presets** bundled with the app.
- **No track-level preset** (preset that includes steps/mixer). Presets are sound-only.
- **No schema version bump.** Zero users in production; we make the breaking shape change cleanly. A 2-line compat read in the reconciler protects the developer's own localStorage state from silently degrading. (See §6.)
- **No networking.** Presets are JSON-serializable, forward-compatible with the future WebSocket sync goal, but live entirely on the file system for now.

## 3. Module layout

```
src/project/
├── preset.ts                # NEW — Preset type, serialize/deserialize, applyPreset
├── preset.test.ts           # NEW
├── preset-file-io.ts        # NEW — savePresetToFile, openPresetFromFile, PresetFileError
├── preset-file-io.test.ts   # NEW
├── types.ts                 # SynthEngineParams gains `mode`; ProjectTrack drops `playMode`
├── factory.ts               # freshTrack drops playMode; synth DEFAULT_PARAMS gains mode='mono'
├── storage.ts               # reconcileTrack: drop playMode, add legacy-playMode compat read
├── file-io.ts               # extensions: .prj.json (suggested); accept both .json and .prj.json
└── index.ts                 # re-export preset API
```

## 4. Data model

### 4.1 Synth engine gains `mode`

In `src/engine/SynthEngine.ts`:

```ts
export interface SynthEngineParams {
  // ... existing fields ...
  mode: 'mono' | 'poly';  // NEW
}

export const DEFAULT_PARAMS: SynthEngineParams = {
  // ... existing defaults ...
  mode: 'mono',  // NEW
};
```

### 4.2 `ProjectTrack` loses `playMode`

In `src/project/types.ts`:

```ts
export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;
  mixer: MixerState;
  // playMode REMOVED
  steps: Step[];
}
```

`PROJECT_SCHEMA_VERSION` stays at `1`.

### 4.3 `Preset` shape

In `src/project/preset.ts`:

```ts
export const PRESET_SCHEMA_VERSION = 1 as const;

export interface Preset {
  schemaVersion: 1;
  engineType: EngineType;
  params: EngineParamsMap[EngineType];   // narrowed via engineType at use sites
}

// Typed factory for callers that know the engine at compile time.
export function makePreset<T extends EngineType>(
  engineType: T,
  params: EngineParamsMap[T],
): Preset;
```

## 5. Public API

### 5.1 In `src/project/preset.ts`

```ts
export function serializePreset(preset: Preset): string;

// Throws PresetFileError on truly unrecoverable input (bad JSON, unknown
// engineType, etc.). Reconciles missing params against the engine's
// DEFAULT_PARAMS so older preset files with fewer fields load cleanly.
export function deserializePreset(text: string): Preset;

// In-place: applies preset.params to track.engines[preset.engineType]
// (via Object.assign) and sets track.engineType = preset.engineType.
// Other engines on the track, the mixer, the steps, all untouched.
// Preserves reactive proxy identity (same pattern as replaceProject).
export function applyPreset(track: ProjectTrack, preset: Preset): void;
```

### 5.2 In `src/project/preset-file-io.ts`

```ts
export class PresetFileError extends Error {
  constructor(message: string, public readonly cause?: unknown);
}

// suggestedName defaults to `${preset.engineType}-preset.chnl.json`
export function savePresetToFile(
  preset: Preset,
  suggestedName?: string,
): Promise<void>;

// Returns null if the user cancels. Throws PresetFileError for unreadable
// or corrupt files.
export function openPresetFromFile(): Promise<Preset | null>;
```

Both follow the exact pattern of `saveProjectToFile` / `openProjectFromFile`:
- Native `showSaveFilePicker` / `showOpenFilePicker` where available
- Download-anchor / `<input type="file">` fallbacks
- `AbortError` from user cancellation caught silently
- File-picker `types` use `'application/json': ['.chnl.json']`

## 6. Backward compat (developer's own localStorage state)

Reconciler in `storage.ts` gets a small legacy read. In `reconcileTrack`:

```ts
function reconcileTrack(raw: any, fresh: ProjectTrack): ProjectTrack {
  // ... existing reconcile logic ...

  // Legacy compat: pre-refactor localStorage had `playMode` on the track.
  // No schema bump (zero users), so we silently absorb the old field here
  // instead of via a formal migration.
  if (raw?.playMode === 'chord') {
    reconciled.engines.synth.mode = 'poly';
  }

  return reconciled;
}
```

That's it — 2 lines + 1 test. The old `playMode` field is silently dropped because the reconciler rebuilds a fresh-shaped object from `freshTrack()` and never copies unknown fields.

## 7. File extensions

| Type | Current | New | Picker accept |
|---|---|---|---|
| Project | `.json` (suggested `fiddle-project.json`) | `.prj.json` (suggested `fiddle-project.prj.json`) | `.json`, `.prj.json` (legacy + new) |
| Preset | — | `.chnl.json` (suggested `<engineType>-preset.chnl.json`) | `.chnl.json` |

The project picker accepting both `.json` and `.prj.json` is for the developer's own already-saved files. Once you've re-saved a project, it'll be a `.prj.json`.

## 8. UI integration

### 8.1 `NEW` button — header transport

In `App.vue`, between `PLAY` and `SAVE`:

```vue
<button @click="onNew" title="Discard current project and start fresh">NEW</button>

<script setup>
import { freshProject, replaceProject } from './project';

const onNew = () => {
  if (confirm('Discard current project and start fresh?')) {
    replaceProject(project, freshProject());
  }
};
</script>
```

`freshProject()` already exists in `factory.ts`. `replaceProject` already exists in `storage.ts`. Net new code: the button + 3-line handler.

### 8.2 `SAVE PRESET` / `LOAD PRESET` — focused track header

In `App.vue` `.focused-view-header`, alongside `.engine-selector`. Only visible when a track is focused (i.e., this whole block is already inside `v-else` for `activeTrackIndex !== null`).

```vue
<div class="preset-controls">
  <button @click="onSavePreset">SAVE PRESET</button>
  <button @click="onLoadPreset">LOAD PRESET</button>
</div>

<script setup>
import { savePresetToFile, openPresetFromFile, applyPreset, makePreset } from './project';

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
</script>
```

`applyPreset` mutates the reactive proxy in place, so the existing watchers in `buildAudioState` fire as a cascade (engineType change → swap engine with 20ms fade; engine slice change → applyParams). No teardown needed.

### 8.3 Mono/Poly toggle — moves from Tracker.vue to SynthPanel.vue

**Remove** in `src/components/Tracker.vue` (~lines 30-43): the mono/chord button pair and the `update:playMode` emit. Tracker continues to receive `mode` as a prop so its row-rendering branch (`synth-row` vs `chord-row`) still works — but it no longer renders the toggle UI.

**Add** in `src/components/SynthPanel.vue`: a small two-button mono/poly toggle, styled to match existing controls, near the top of the synth panel. Reads/writes via `v-model:mode` exposed by the parent (`App.vue`). The toggle is only ever visible when `engineType === 'synth'` (i.e., when SynthPanel is being rendered), so drum panels naturally have no toggle.

`useSynth.ts` exposes the toggle binding by renaming the existing `playMode` computed to `synthMode` (or similar) and pointing it at `project.tracks[activeTrackIndex.value].engines.synth.mode`.

## 9. Sequencer

`useSynth.ts:345` currently reads `const currentPlayMode = track.playMode || 'mono';`. Replace with:

```ts
const currentPlayMode = track.engines.synth.mode;  // always defined post-reconcile
```

The drum branch of the same step-trigger loop already ignores playMode entirely, so nothing changes for drums.

## 10. Testing

### 10.1 New tests in `preset.test.ts`
- `serializePreset` / `deserializePreset` round-trip for each of the 5 engine types
- `deserializePreset` fills missing fields via the engine's `DEFAULT_PARAMS` (forward-compat for older preset files)
- `deserializePreset` throws `PresetFileError` on truly bad input (malformed JSON, unknown engineType)
- `applyPreset` preserves track reference identity (`track === track` after)
- `applyPreset` switches engineType, applies params, leaves other engines + mixer + steps untouched
- `applyPreset` followed by toggling back to the previous engine type restores the previous engine's params (proves dense model preservation)

### 10.2 New tests in `preset-file-io.test.ts`
Mirror `file-io.test.ts`. Per-file `// @vitest-environment jsdom` directive.
- Native picker path: `vi.stubGlobal` for `showSaveFilePicker` / `showOpenFilePicker`
- Fallback path: download-anchor + `<input type=file>` change event
- User cancellation (AbortError + null) handled silently
- Bad-file → `PresetFileError`

### 10.3 New / updated tests in `storage.test.ts`
- Legacy compat: a v1 project payload with `track.playMode === 'chord'` reconciles into `track.engines.synth.mode === 'poly'`
- Legacy compat: `track.playMode === 'mono'` and no `playMode` both leave `synth.mode` at its default `'mono'`
- The `playMode` field on the input is silently dropped (not present on the reconciled track)
- Update existing tests that referenced `track.playMode` to use `track.engines.synth.mode`

### 10.4 New / updated tests for App.vue helpers / useSynth
- `onNew` handler: `confirm` returning `true` resets; returning `false` is a no-op (mock `confirm`)

### 10.5 Browser verification (user)
- Click NEW → confirm prompt → OK → all four tracks back to defaults
- Click NEW → confirm prompt → Cancel → nothing changes
- Set track 1's synth to poly, save preset, then click NEW, then load that preset onto track 1 → synth params restored, mode is poly
- Save a kick preset, load it onto a track currently set to synth → track switches to kick, kick params from preset apply, synth params on that track are still there if you switch back to SYNTH
- Open an old `.json` project file → still loads via the picker
- Open a corrupted `.chnl.json` → alert, app doesn't crash

## 11. Error handling

| Failure | Behavior |
|---|---|
| User cancels NEW confirm prompt | No-op |
| User cancels save preset picker | Silent (caught AbortError) |
| User cancels load preset picker | Silent (returns null) |
| Preset file is malformed JSON | `PresetFileError` thrown to caller → `alert(...)` |
| Preset file's `engineType` is unknown | `PresetFileError` thrown |
| Preset file is missing some params | `deserializePreset` reconciles against `DEFAULT_PARAMS` — silently fills, doesn't throw |

## 12. Acceptance criteria

1. ✓ `SynthEngineParams` has `mode: 'mono' | 'poly'`; `DEFAULT_PARAMS.synth.mode === 'mono'`.
2. ✓ `ProjectTrack` no longer has `playMode`.
3. ✓ `reconcileTrack` translates legacy `playMode === 'chord'` into `synth.mode = 'poly'` (2-line compat read).
4. ✓ `src/project/preset.ts` exports `Preset`, `makePreset`, `serializePreset`, `deserializePreset`, `applyPreset`.
5. ✓ `src/project/preset-file-io.ts` exports `savePresetToFile`, `openPresetFromFile`, `PresetFileError`.
6. ✓ All three preset functions + `applyPreset` re-exported from `src/project/index.ts`.
7. ✓ `App.vue` has a NEW button in the header (with `confirm()` prompt) and SAVE PRESET / LOAD PRESET buttons in the focused track view.
8. ✓ Mono/Poly toggle moved from Tracker to SynthPanel.
9. ✓ Project picker accepts both `.json` and `.prj.json`; new saves suggest `.prj.json`.
10. ✓ Preset picker accepts and suggests `.chnl.json`.
11. ✓ Loading a preset of a different engine type switches the track's engine; the previously-active engine's params on that track are preserved.
12. ✓ All existing tests pass; new tests added; `vue-tsc` + `vite build` clean.
13. ✓ Documented in `docs/ARCHITECTURE.md` (extend §13 with a Presets paragraph).

## 13. Out-of-scope reminders

- No preset browser UI; no rename/delete inside the app.
- No factory presets, no bundled patches.
- No track-level preset (engine + params + mixer + steps).
- No bulk export/import.
- No drag-and-drop preset load.
- No networking.

## 14. Open questions

None — design is fully specified. Move to writing-plans.
