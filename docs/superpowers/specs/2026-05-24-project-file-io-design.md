# Project File I/O — Design

**Status:** Draft, awaiting user review.
**Branch:** `feature/project-model` (extends the in-flight branch; no merge to `main` until user approves the combined branch).
**Builds on:** `docs/superpowers/specs/2026-05-23-project-model-design.md`.

## 1. Goals

- **Save the current project to a `.json` file on disk** via a browser file picker. The file is a self-contained snapshot interchangeable with localStorage's `fiddle:project` payload.
- **Open a `.json` project file from disk** and replace the current in-memory project with its contents.
- **Reuse the existing pipeline.** Loading a file goes through the same `migrateToLatest` → `reconcileWithDefaults` path as localStorage, so old/partial files round-trip safely.
- **Work in every modern browser.** Native File System Access API (Chrome/Edge) when present; download-anchor + `<input type="file">` fallback for Safari/Firefox.

## 2. Non-goals

- **No "current file" tracking.** Save always shows a picker (Save-as semantics — user picks where to put each snapshot every time). Auto-save to localStorage already covers "don't lose my work between sessions."
- **No project picker / browse-saved-files UI.** That's a separate future feature.
- **No multi-user sync.** Network code is still out of scope. The `Project` JSON is the same shape that will eventually travel over WebSockets, so this work is forward-compatible.
- **No file rename / move / delete from inside the app.** The OS owns the file.

## 3. Module layout

```
src/project/
├── file-io.ts        # NEW — saveProjectToFile, openProjectFromFile
├── file-io.test.ts   # NEW — mocked-picker tests
├── storage.ts        # +serializeProject, +deserializeProject, +replaceProject
├── storage.test.ts   # +tests for the three new helpers
└── index.ts          # add exports for the new public surface
```

## 4. Type signatures

In `src/project/storage.ts`:

```ts
// JSON snapshot of the project as written to disk / localStorage.
export function serializeProject(project: Project): string;

// Pure inverse: parse → migrateToLatest → reconcileWithDefaults.
// Throws on truly unrecoverable input (e.g. unknown future schemaVersion;
// migrateToLatest already throws here). Returns a freshProject() for malformed
// JSON (logs warning), matching loadProject's defensive posture.
export function deserializeProject(text: string): Project;

// Mutate `target` in place to match `source`. Preserves target's reactive
// proxy identity so installed watchers in buildAudioState keep firing on the
// same object. Does NOT replace target's references — it Object.assigns
// fields, splices steps in place, etc.
export function replaceProject(target: Project, source: Project): void;
```

In `src/project/file-io.ts`:

```ts
// Show a save picker (native API where available, download-anchor fallback).
// Resolves when the file has been written, or after the user cancels (in
// which case nothing happens). Errors during writing are caught and logged.
export function saveProjectToFile(
  project: Project,
  suggestedName?: string,        // default: 'fiddle-project.json'
): Promise<void>;

// Show an open picker and return the parsed project. Returns null if the
// user cancelled. Throws ProjectFileError for unreadable / corrupt files
// (caller decides how to surface).
export function openProjectFromFile(): Promise<Project | null>;

export class ProjectFileError extends Error {
  constructor(message: string, public readonly cause?: unknown);
}
```

## 5. `replaceProject` semantics (the load-bearing piece)

The existing watchers in `buildAudioState` close over `project` (the reactive proxy created at module init). They have getter functions like `() => project.tracks[i].engineType`. If we reassigned the module-scope `project` binding, those getters would still read from the old proxy — silent breakage.

`replaceProject(target, source)` therefore **never replaces the proxy identity**. It mutates per leaf:

```ts
// Pseudocode — actual implementation will be written in the plan
export function replaceProject(target: Project, source: Project): void {
  target.schemaVersion = source.schemaVersion;
  target.bpm = source.bpm;

  for (let i = 0; i < 4; i++) {
    const t = target.tracks[i];
    const s = source.tracks[i];

    t.engineType = s.engineType;
    t.playMode = s.playMode;

    for (const engine of ['synth','kick','hat','snare','clap'] as const) {
      Object.assign(t.engines[engine], s.engines[engine]);
    }

    Object.assign(t.mixer, s.mixer);

    // Steps are always length 16 (reconciler guarantees this), so we mutate
    // in place rather than splice/replace.
    for (let j = 0; j < 16; j++) {
      Object.assign(t.steps[j], s.steps[j]);
    }
  }
}
```

This causes the following watcher cascade (all desirable):

1. Each engine slice watcher fires once with the changed fields → `engines[i].applyParams(diff)` updates audio params.
2. Each `engineType` watcher fires for tracks whose engine changed → `syncTrackToEngine` swaps engines (with the 20 ms fade we already have).
3. Each `mixer` watcher fires → `updateMixerGains` applies new track gains.
4. The auto-save watcher (`watch(project, save, { deep: true })`) fires once after the dust settles → 500 ms later, localStorage matches the file.

No teardown / rebuild of audio state needed.

## 6. File I/O — picker strategy

```ts
// saveProjectToFile
const json = serializeProject(project);

if ('showSaveFilePicker' in window) {
  // Native API (Chrome/Edge). Single user gesture, no leftover UI.
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{
      description: 'Fiddle project',
      accept: { 'application/json': ['.json'] },
    }],
  });
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
} else {
  // Fallback (Safari/Firefox). Programmatic download.
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
```

User-cancellation of the native picker throws an `AbortError`. We catch and swallow it (no error to the user — they cancelled on purpose).

```ts
// openProjectFromFile
if ('showOpenFilePicker' in window) {
  let handles: FileSystemFileHandle[];
  try {
    handles = await window.showOpenFilePicker({
      types: [{ accept: { 'application/json': ['.json'] } }],
      multiple: false,
    });
  } catch (e) {
    if (isAbortError(e)) return null;
    throw e;
  }
  const file = await handles[0].getFile();
  const text = await file.text();
  return deserializeProject(text);
}

// Fallback: hidden <input type="file">
return await openFileViaInput();
```

The `<input type="file">` fallback wraps the input in a one-shot Promise that resolves on `change` and resolves to `null` if the user closes the dialog without picking.

## 7. UI integration

Two new buttons in `App.vue`'s header (next to BPM / Play), labeled **Save** and **Open**:

```vue
<button @click="onSave">Save</button>
<button @click="onOpen">Open</button>

<script setup>
import { saveProjectToFile, openProjectFromFile, replaceProject } from './project';

const onSave = () => saveProjectToFile(project);

const onOpen = async () => {
  try {
    const loaded = await openProjectFromFile();
    if (loaded) replaceProject(project, loaded);
  } catch (e) {
    // Brief inline error — TBD on exact surface; alert() is fine for now.
    console.warn('Open failed:', e);
    alert(`Could not open project: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};
</script>
```

Styling matches the existing header buttons (Play, Reset, etc.).

## 8. Error handling

| Failure | Behavior |
|---|---|
| User cancels native picker | Silent no-op (caught `AbortError`) |
| User closes `<input type="file">` without picking | Silent no-op (resolves to null) |
| File contents are not valid JSON | `deserializeProject` warns and returns `freshProject()` — same as `loadProject`. User gets an "empty project" UI; not ideal, but recoverable. *(Decision: acceptable for v1; future enhancement could throw and let the UI show "this isn't a project file".)* |
| File has a future `schemaVersion` | `migrateToLatest` throws → `openProjectFromFile` re-throws as `ProjectFileError` → UI shows the alert message |
| `writable.write` fails (quota, permission, etc.) | Logged to console; thrown back to `onSave` which could surface an error toast. Acceptable for v1. |

## 9. Testing approach

**Unit (in `storage.test.ts`):**
- `serializeProject` produces stable JSON matching `JSON.stringify(toRaw(project))`.
- `deserializeProject` round-trips a freshProject and a doc that's missing fields (delegates to reconciler).
- `replaceProject` preserves `target` reference identity (`target === target` after, `target.tracks[0] === sameTrackBefore`), mutates field values, and fires deep-watcher (verify by `watch(project, …, { deep: true })` callback invocation).

**Unit (in `file-io.test.ts`):**
- `saveProjectToFile` calls `showSaveFilePicker` when present and writes the serialized JSON; falls back to creating an anchor + clicking it when not present.
- `openProjectFromFile` calls `showOpenFilePicker` when present; falls back to `<input type="file">` change event when not.
- Both paths use `vi.stubGlobal` to fake the picker APIs.

**Browser verification (you):**
- Save in Chrome → native picker, file lands at chosen location, contents match localStorage.
- Save in Safari → download lands in Downloads folder.
- Open in Chrome → native picker, project loads, audio engines update, oscilloscope keeps running.
- Open in Safari → `<input>` picker, same behavior.
- Open a corrupted file → user-visible error, app doesn't crash.

## 10. Acceptance criteria

1. ✓ `src/project/file-io.ts` exists with `saveProjectToFile`, `openProjectFromFile`, `ProjectFileError`.
2. ✓ `serializeProject` / `deserializeProject` / `replaceProject` live in `storage.ts`.
3. ✓ All three are re-exported from `src/project/index.ts`.
4. ✓ App.vue has Save and Open buttons; both call into the helpers above.
5. ✓ Save round-trips: file written, then Open the same file, then audio/visual state matches.
6. ✓ Open from a partial file (missing engines or fields) fills in defaults via the reconciler.
7. ✓ User-cancellation of either picker is silent.
8. ✓ Open with a future-schemaVersion file shows a user-visible error and leaves state untouched.
9. ✓ `replaceProject` preserves the reactive proxy identity (watchers still fire after).
10. ✓ All existing tests still pass; new tests added; `vue-tsc` + `vite build` clean.
11. ✓ Documented in `docs/ARCHITECTURE.md` under §13 (Project module).

## 11. Out-of-scope reminders

- No named presets, no project picker UI, no auto-snapshot history.
- No networking, no real-time sync.
- No "current file" tracking / Cmd+S → silent overwrite.
- No drag-and-drop file open.
- No multi-file batch import.

## 12. Open questions

None — design is fully specified. Move to writing-plans.
