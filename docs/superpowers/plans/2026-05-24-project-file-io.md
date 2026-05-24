# Project File I/O Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add file Save/Open to Fiddle Synth — `.json` files round-trip through the same migrate+reconcile pipeline as localStorage, with native File System Access API support and download/input fallbacks.

**Architecture:** Three pure helpers (`serializeProject`, `deserializeProject`, `replaceProject`) extend `src/project/storage.ts`. A new `src/project/file-io.ts` wraps the browser pickers. `App.vue` gets two header buttons. `replaceProject` mutates the existing reactive root in place so installed watchers keep firing — no audio teardown needed on Open.

**Tech Stack:** Vue 3 + TypeScript + Vite + Vitest. File System Access API where available; `<a download>` + `<input type="file">` fallback.

**Spec:** `docs/superpowers/specs/2026-05-24-project-file-io-design.md`
**Branch:** `feature/project-model` (HEAD `cc810f7` at start; do NOT merge to `main` until user approval).

**Branch-per-task workflow.** Each task cuts a sub-branch from `feature/project-model`, lands its work behind green checks, and merges `--no-ff` back. Sub-branch deleted after merge.

**Always-green invariant.** Every commit on `feature/project-model` must pass `npm test` + `npx vue-tsc --noEmit` + `npx vite build`. Start: 119 tests passing.

**Style note.** Match existing patterns: TS with explicit types at boundaries, colocated `*.test.ts`, two-space indent, `vi.stubGlobal` for browser-API mocks. See `src/project/storage.test.ts` for the canonical mock setup (it stubs `localStorage` the same way we'll stub `showSaveFilePicker` etc.).

---

## File map

```
src/project/
├── storage.ts            # +serializeProject, +deserializeProject, +replaceProject
├── storage.test.ts       # +tests for the three new helpers
├── file-io.ts            # NEW — saveProjectToFile, openProjectFromFile, ProjectFileError
├── file-io.test.ts       # NEW — mocked-picker tests
└── index.ts              # add exports
src/
└── App.vue               # +Save/Open buttons + handlers
docs/
└── ARCHITECTURE.md       # update §13 (project module) to mention file-io
```

---

## Phase A — Storage helpers (pure, no UI)

### Task 1: `serializeProject` + `deserializeProject`

Two pure inverses. `serializeProject` produces the JSON string written to disk. `deserializeProject` is the inverse of `loadProject`'s parse step — it reuses `migrateToLatest` + `reconcileWithDefaults`, so partial / old-schema files load gracefully.

**Files:**
- Modify: `src/project/storage.ts` (add two exports + their tiny implementations)
- Modify: `src/project/storage.test.ts` (add a new `describe('serializeProject + deserializeProject')` block)

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t1-serialize
```

- [ ] **Step 2: Add failing tests**

Append to `src/project/storage.test.ts` (after the existing `describe('installAutoSave', …)` block):

```ts
import { serializeProject, deserializeProject } from './storage';

describe('serializeProject', () => {
  it('produces JSON identical to JSON.stringify(toRaw(project))', () => {
    const p = freshProject();
    p.bpm = 144;
    p.tracks[0].engines.synth.filterCutoff = 1234;
    const json = serializeProject(p);
    const parsed = JSON.parse(json);
    expect(parsed.bpm).toBe(144);
    expect(parsed.tracks[0].engines.synth.filterCutoff).toBe(1234);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('strips Vue reactive proxies (uses toRaw under the hood)', () => {
    const { reactive } = require('vue');
    const p = reactive(freshProject());
    p.bpm = 100;
    const json = serializeProject(p);
    // If we hadn't called toRaw, JSON.stringify could leak proxy metadata or
    // throw on circular reactive structures. Spot-check the output is plain.
    const parsed = JSON.parse(json);
    expect(parsed.bpm).toBe(100);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe('deserializeProject', () => {
  it('round-trips through serializeProject', () => {
    const p = freshProject();
    p.bpm = 99;
    p.tracks[1].engines.kick.tune = 70;
    const restored = deserializeProject(serializeProject(p));
    expect(restored.bpm).toBe(99);
    expect(restored.tracks[1].engines.kick.tune).toBe(70);
  });

  it('fills missing fields via the reconciler', () => {
    const partial = JSON.stringify({
      schemaVersion: 1,
      bpm: 130,
      tracks: [{}, {}, {}, {}],
    });
    const restored = deserializeProject(partial);
    expect(restored.tracks[0].engines.synth).toBeDefined();
    expect(restored.tracks[0].steps).toHaveLength(16);
  });

  it('returns freshProject (with warn) on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restored = deserializeProject('{not json');
    expect(restored.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws for an unknown future schemaVersion', () => {
    const future = JSON.stringify({ schemaVersion: 99, bpm: 100, tracks: [] });
    expect(() => deserializeProject(future)).toThrowError(/Unknown project schemaVersion: 99/);
  });
});
```

- [ ] **Step 3: Run tests, confirm failure**

```bash
npx vitest run src/project/storage.test.ts
```
Expected: FAIL — `serializeProject is not exported`.

- [ ] **Step 4: Implement the two helpers**

In `src/project/storage.ts`, add these exports after `installAutoSave` (preserve existing imports):

```ts
// JSON snapshot suitable for writing to disk or localStorage. Going through
// toRaw strips Vue's reactive proxies so JSON.stringify can't trip on proxy
// metadata or circular reactive structures.
export function serializeProject(project: Project): string {
  return JSON.stringify(toRaw(project));
}

// Inverse of serializeProject. Mirrors loadProject's parse step: invalid
// JSON warns + returns a freshProject; valid JSON goes through
// migrateToLatest + reconcileWithDefaults. Future-schemaVersion still
// throws (the only unrecoverable case).
export function deserializeProject(text: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn('Project deserialize failed (invalid JSON), starting fresh:', e);
    return freshProject();
  }
  const migrated = migrateToLatest(parsed);
  return reconcileWithDefaults(migrated);
}
```

`toRaw`, `migrateToLatest`, `reconcileWithDefaults`, and `freshProject` are already imported at the top of `storage.ts` from T7 of the prior plan — confirm by grep before editing. If `freshProject` is no longer imported (it was dropped because the file didn't use it directly), add it back to the import block from `./factory`.

- [ ] **Step 5: Run tests, confirm pass**

```bash
npx vitest run src/project/storage.test.ts
```
Expected: existing storage tests + 6 new tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: 119 + 6 = 125 tests pass; tsc clean; build clean.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/project/storage.ts src/project/storage.test.ts
git commit -m "feat(project): serializeProject + deserializeProject

Pair of pure functions for file persistence. serializeProject is just
JSON.stringify(toRaw(project)). deserializeProject is the inverse and
reuses the loadProject pipeline (migrateToLatest + reconcileWithDefaults).
Foundation for file-based save/open."

git checkout feature/project-model
git merge --no-ff feature/project-model-t1-serialize -m "Merge T1: serialize/deserialize"
git branch -d feature/project-model-t1-serialize
```

---

### Task 2: `replaceProject`

In-place mutation of the existing reactive `project` root. **Load-bearing for Open** — preserving the proxy identity is what keeps `buildAudioState`'s watchers alive.

**Files:**
- Modify: `src/project/storage.ts` (add `replaceProject` export)
- Modify: `src/project/storage.test.ts` (add `describe('replaceProject')` block)

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t2-replace
```

- [ ] **Step 2: Add failing tests**

Append to `src/project/storage.test.ts`:

```ts
import { replaceProject } from './storage';
import { reactive, watch, nextTick } from 'vue';

describe('replaceProject', () => {
  it('preserves the target reactive proxy identity (=== before and after)', () => {
    const target = reactive(freshProject());
    const targetTrack0 = target.tracks[0];
    const targetEngines0Synth = target.tracks[0].engines.synth;
    const targetMixer0 = target.tracks[0].mixer;
    const targetStep0 = target.tracks[0].steps[0];

    const source = freshProject();
    source.bpm = 99;
    source.tracks[0].engines.synth.filterCutoff = 4321;

    replaceProject(target, source);

    expect(target.tracks[0]).toBe(targetTrack0);
    expect(target.tracks[0].engines.synth).toBe(targetEngines0Synth);
    expect(target.tracks[0].mixer).toBe(targetMixer0);
    expect(target.tracks[0].steps[0]).toBe(targetStep0);
  });

  it('mutates top-level fields (schemaVersion, bpm)', () => {
    const target = reactive(freshProject());
    const source = freshProject();
    source.bpm = 77;
    replaceProject(target, source);
    expect(target.bpm).toBe(77);
    expect(target.schemaVersion).toBe(1);
  });

  it('mutates engine slot fields without rebinding the slot object', () => {
    const target = reactive(freshProject());
    const synthRef = target.tracks[0].engines.synth;
    const source = freshProject();
    source.tracks[0].engines.synth.filterCutoff = 1234;
    replaceProject(target, source);
    expect(target.tracks[0].engines.synth).toBe(synthRef);
    expect(target.tracks[0].engines.synth.filterCutoff).toBe(1234);
  });

  it('mutates mixer + playMode + engineType per track', () => {
    const target = reactive(freshProject());
    const source = freshProject();
    source.tracks[2].engineType = 'kick';
    source.tracks[2].playMode = 'chord';
    source.tracks[2].mixer.volume = 0.25;
    replaceProject(target, source);
    expect(target.tracks[2].engineType).toBe('kick');
    expect(target.tracks[2].playMode).toBe('chord');
    expect(target.tracks[2].mixer.volume).toBe(0.25);
  });

  it('mutates each step in place (preserves step proxy identity)', () => {
    const target = reactive(freshProject());
    const step5Ref = target.tracks[0].steps[5];
    const source = freshProject();
    source.tracks[0].steps[5].note = 'C';
    source.tracks[0].steps[5].velocity = 0.42;
    replaceProject(target, source);
    expect(target.tracks[0].steps[5]).toBe(step5Ref);
    expect(target.tracks[0].steps[5].note).toBe('C');
    expect(target.tracks[0].steps[5].velocity).toBe(0.42);
  });

  it('fires the deep watcher (Vue picks up the mutations)', async () => {
    const target = reactive(freshProject());
    const fired = vi.fn();
    watch(target, fired, { deep: true });

    const source = freshProject();
    source.bpm = 88;
    replaceProject(target, source);

    await nextTick();
    expect(fired).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests, confirm failure**

```bash
npx vitest run src/project/storage.test.ts
```
Expected: FAIL — `replaceProject is not exported`.

- [ ] **Step 4: Implement `replaceProject`**

Add to `src/project/storage.ts` (after `deserializeProject`):

```ts
// Mutate `target` in place to match `source`, preserving the reactive proxy
// identity of every nested object. Vue watchers installed on `target` (e.g.
// the per-slice watchers in useSynth's buildAudioState) keep firing because
// the underlying proxy objects are the same — only their fields change.
//
// This is the right semantics for "Open": load a project from disk without
// tearing down the audio graph. The watcher cascade applies params,
// updates mixer gains, and swaps engines exactly as a sequence of manual
// knob turns would.
export function replaceProject(target: Project, source: Project): void {
  target.schemaVersion = source.schemaVersion;
  target.bpm = source.bpm;

  for (let i = 0; i < 4; i++) {
    const t = target.tracks[i];
    const s = source.tracks[i];

    t.engineType = s.engineType;
    t.playMode = s.playMode;

    for (const engine of ENGINE_KEYS) {
      Object.assign(t.engines[engine], s.engines[engine]);
    }

    Object.assign(t.mixer, s.mixer);

    for (let j = 0; j < 16; j++) {
      Object.assign(t.steps[j], s.steps[j]);
    }
  }
}

const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap'] as const;
```

`ENGINE_KEYS` is a file-local constant — declare it once at the bottom (or top, whichever fits the existing layout). If the file already defines a similar list (e.g. an `ENGINE_SLICES` array), reuse it instead of duplicating.

- [ ] **Step 5: Run tests, confirm pass**

```bash
npx vitest run src/project/storage.test.ts
```
Expected: previous storage tests + 6 new tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: 125 + 6 = 131 tests pass; tsc clean; build clean.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/project/storage.ts src/project/storage.test.ts
git commit -m "feat(project): replaceProject — in-place reactive root swap

Mutates target's fields in place so Vue's reactive proxy identity stays
constant. Watchers installed in useSynth.buildAudioState (engine params,
engineType, mixer) keep firing without teardown. Used by Open to load a
file into the live session without rebuilding the audio graph."

git checkout feature/project-model
git merge --no-ff feature/project-model-t2-replace -m "Merge T2: replaceProject"
git branch -d feature/project-model-t2-replace
```

---

## Phase B — File I/O wrapper

### Task 3: `file-io.ts` save side + `ProjectFileError`

The class lives here because `openProjectFromFile` also throws it. Plus `saveProjectToFile` and its native-vs-fallback strategy.

**Files:**
- Create: `src/project/file-io.ts`
- Create: `src/project/file-io.test.ts`

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t3-save
```

- [ ] **Step 2: Write the failing test**

Create `src/project/file-io.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveProjectToFile, ProjectFileError } from './file-io';
import { freshProject } from './factory';

function makeFakeWritable() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ProjectFileError', () => {
  it('preserves the cause', () => {
    const cause = new Error('underlying');
    const e = new ProjectFileError('top', cause);
    expect(e.message).toBe('top');
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('ProjectFileError');
  });
});

describe('saveProjectToFile — native (showSaveFilePicker)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uses the native picker and writes serialized JSON', async () => {
    const writable = makeFakeWritable();
    const handle = { createWritable: vi.fn().mockResolvedValue(writable) };
    const picker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal('showSaveFilePicker', picker);

    const p = freshProject();
    p.bpm = 140;
    await saveProjectToFile(p, 'my-song.json');

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0][0].suggestedName).toBe('my-song.json');
    expect(picker.mock.calls[0][0].types[0].accept).toEqual({
      'application/json': ['.json'],
    });
    expect(writable.write).toHaveBeenCalledTimes(1);
    const written = writable.write.mock.calls[0][0];
    expect(JSON.parse(written).bpm).toBe(140);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('defaults suggestedName to "fiddle-project.json"', async () => {
    const writable = makeFakeWritable();
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue(writable),
    });
    vi.stubGlobal('showSaveFilePicker', picker);

    await saveProjectToFile(freshProject());
    expect(picker.mock.calls[0][0].suggestedName).toBe('fiddle-project.json');
  });

  it('swallows AbortError (user cancellation)', async () => {
    const abort = new DOMException('User aborted', 'AbortError');
    const picker = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal('showSaveFilePicker', picker);

    await expect(saveProjectToFile(freshProject())).resolves.toBeUndefined();
  });

  it('wraps other errors in ProjectFileError', async () => {
    const picker = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    vi.stubGlobal('showSaveFilePicker', picker);

    await expect(saveProjectToFile(freshProject()))
      .rejects.toBeInstanceOf(ProjectFileError);
  });
});

describe('saveProjectToFile — fallback (download anchor)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // No showSaveFilePicker → fallback path
  });

  it('creates and clicks a download anchor with serialized JSON', async () => {
    const fakeAnchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    };
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') return fakeAnchor as unknown as HTMLAnchorElement;
      // Fall through for anything else (jsdom default)
      return document.createElement.call(document, tag) as HTMLElement;
    });
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);
    const urlCreate = vi.fn().mockReturnValue('blob:fake-url');
    const urlRevoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: urlCreate, revokeObjectURL: urlRevoke });

    const p = freshProject();
    p.bpm = 90;
    await saveProjectToFile(p, 'fallback.json');

    expect(urlCreate).toHaveBeenCalledTimes(1);
    const blob = urlCreate.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    expect(JSON.parse(text).bpm).toBe(90);

    expect(fakeAnchor.href).toBe('blob:fake-url');
    expect(fakeAnchor.download).toBe('fallback.json');
    expect(fakeAnchor.click).toHaveBeenCalledTimes(1);
    expect(fakeAnchor.remove).toHaveBeenCalledTimes(1);
    expect(urlRevoke).toHaveBeenCalledWith('blob:fake-url');

    createElementSpy.mockRestore();
    appendSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run test, confirm failure**

```bash
npx vitest run src/project/file-io.test.ts
```
Expected: FAIL — `Cannot find module './file-io'`.

- [ ] **Step 4: Implement `src/project/file-io.ts` (save half only)**

```ts
import type { Project } from './types';
import { serializeProject } from './storage';

export class ProjectFileError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

// Save the project to disk. On Chrome/Edge uses the native File System
// Access API. On Safari/Firefox falls back to a programmatic download
// anchor. User cancellation of the native picker is silent (no error).
export async function saveProjectToFile(
  project: Project,
  suggestedName: string = 'fiddle-project.json',
): Promise<void> {
  const json = serializeProject(project);

  const picker = (globalThis as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName,
        types: [{
          description: 'Fiddle project',
          accept: { 'application/json': ['.json'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (e) {
      if (isAbortError(e)) return;
      throw new ProjectFileError(
        `Failed to save project: ${e instanceof Error ? e.message : 'unknown error'}`,
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
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
npx vitest run src/project/file-io.test.ts
```
Expected: 6 tests pass (1 error + 4 native + 1 fallback).

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: 131 + 6 = 137 tests pass; tsc clean; build clean.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/project/file-io.ts src/project/file-io.test.ts
git commit -m "feat(project): saveProjectToFile + ProjectFileError

Native showSaveFilePicker on Chrome/Edge with download-anchor fallback for
Safari/Firefox. User cancellation (AbortError) is silent. Other failures
wrapped in ProjectFileError so the caller can surface a user-visible message."

git checkout feature/project-model
git merge --no-ff feature/project-model-t3-save -m "Merge T3: saveProjectToFile"
git branch -d feature/project-model-t3-save
```

---

### Task 4: `openProjectFromFile`

The open side. Native `showOpenFilePicker` + `<input type="file">` fallback. Returns `Project | null` (null = user cancelled).

**Files:**
- Modify: `src/project/file-io.ts` (add `openProjectFromFile`)
- Modify: `src/project/file-io.test.ts` (add new describe blocks)

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t4-open
```

- [ ] **Step 2: Append failing tests**

Append to `src/project/file-io.test.ts`:

```ts
import { openProjectFromFile } from './file-io';
import { PROJECT_SCHEMA_VERSION } from './types';

function makeFakeFile(contents: string): File {
  return new File([contents], 'test.json', { type: 'application/json' });
}

describe('openProjectFromFile — native (showOpenFilePicker)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the parsed project from the picked file', async () => {
    const seed = JSON.stringify({
      schemaVersion: 1,
      bpm: 156,
      tracks: [{}, {}, {}, {}],
    });
    const handle = { getFile: vi.fn().mockResolvedValue(makeFakeFile(seed)) };
    const picker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', picker);

    const project = await openProjectFromFile();
    expect(project).not.toBeNull();
    expect(project!.bpm).toBe(156);
    expect(project!.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(picker.mock.calls[0][0].multiple).toBe(false);
  });

  it('returns null on user cancellation (AbortError)', async () => {
    const abort = new DOMException('User aborted', 'AbortError');
    const picker = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal('showOpenFilePicker', picker);

    const project = await openProjectFromFile();
    expect(project).toBeNull();
  });

  it('throws ProjectFileError for future schemaVersion', async () => {
    const seed = JSON.stringify({ schemaVersion: 99, bpm: 100, tracks: [] });
    const handle = { getFile: vi.fn().mockResolvedValue(makeFakeFile(seed)) };
    const picker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', picker);

    await expect(openProjectFromFile()).rejects.toBeInstanceOf(ProjectFileError);
  });

  it('wraps other picker errors in ProjectFileError', async () => {
    const picker = vi.fn().mockRejectedValue(new Error('disk read failed'));
    vi.stubGlobal('showOpenFilePicker', picker);

    await expect(openProjectFromFile()).rejects.toBeInstanceOf(ProjectFileError);
  });
});

describe('openProjectFromFile — fallback (<input type="file">)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('returns the parsed project after change event with a file', async () => {
    const seed = JSON.stringify({ schemaVersion: 1, bpm: 95, tracks: [{}, {}, {}, {}] });
    const file = makeFakeFile(seed);
    const fakeInput = {
      type: '',
      accept: '',
      style: { display: '' },
      files: [file] as unknown as FileList,
      click: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    let onChange: (() => void) | null = null;
    fakeInput.addEventListener = vi.fn((evt: string, cb: () => void) => {
      if (evt === 'change') onChange = cb;
    });

    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'input') return fakeInput as unknown as HTMLInputElement;
      return document.createElement.call(document, tag) as HTMLElement;
    });
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);

    const promise = openProjectFromFile();

    // Wait for the input.click() to be called before firing change
    await Promise.resolve();
    expect(fakeInput.click).toHaveBeenCalled();
    onChange!();

    const project = await promise;
    expect(project).not.toBeNull();
    expect(project!.bpm).toBe(95);

    createSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('returns null when cancel event fires', async () => {
    const fakeInput = {
      type: '',
      accept: '',
      style: { display: '' },
      files: null as unknown as FileList,
      click: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    let onCancel: (() => void) | null = null;
    fakeInput.addEventListener = vi.fn((evt: string, cb: () => void) => {
      if (evt === 'cancel') onCancel = cb;
    });

    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'input') return fakeInput as unknown as HTMLInputElement;
      return document.createElement.call(document, tag) as HTMLElement;
    });
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);

    const promise = openProjectFromFile();
    await Promise.resolve();
    onCancel!();

    const project = await promise;
    expect(project).toBeNull();

    createSpy.mockRestore();
    appendSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run test, confirm failure**

```bash
npx vitest run src/project/file-io.test.ts
```
Expected: FAIL — `openProjectFromFile is not exported`.

- [ ] **Step 4: Append the implementation to `src/project/file-io.ts`**

Add at the bottom of the file:

```ts
import { deserializeProject } from './storage';

// Open a project from disk. On Chrome/Edge uses the native File System
// Access API. On Safari/Firefox falls back to a hidden <input type="file">.
// Returns null if the user cancels. Throws ProjectFileError for unreadable
// or future-schemaVersion files.
export async function openProjectFromFile(): Promise<Project | null> {
  const picker = (globalThis as any).showOpenFilePicker;
  if (typeof picker === 'function') {
    let handles: any[];
    try {
      handles = await picker({
        types: [{
          description: 'Fiddle project',
          accept: { 'application/json': ['.json'] },
        }],
        multiple: false,
      });
    } catch (e) {
      if (isAbortError(e)) return null;
      throw new ProjectFileError(
        `Failed to open project: ${e instanceof Error ? e.message : 'unknown error'}`,
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

function parseOrWrap(text: string): Project {
  try {
    return deserializeProject(text);
  } catch (e) {
    throw new ProjectFileError(
      `Could not load project: ${e instanceof Error ? e.message : 'unknown error'}`,
      e,
    );
  }
}

function pickFileViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
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

Also add `Project` to the type imports at the top of the file (it's already used for the `saveProjectToFile` signature, so should already be there — verify before adding).

- [ ] **Step 5: Run tests, confirm pass**

```bash
npx vitest run src/project/file-io.test.ts
```
Expected: previous 6 + 6 new = 12 tests pass.

- [ ] **Step 6: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: 137 + 6 = 143 tests pass; tsc clean; build clean.

- [ ] **Step 7: Commit + merge sub-branch**

```bash
git add src/project/file-io.ts src/project/file-io.test.ts
git commit -m "feat(project): openProjectFromFile with native + input fallback

Native showOpenFilePicker on Chrome/Edge, hidden <input type=\"file\"> on
Safari/Firefox. Returns null on cancellation. ProjectFileError wraps
unreadable/future-schemaVersion files so the UI can surface them."

git checkout feature/project-model
git merge --no-ff feature/project-model-t4-open -m "Merge T4: openProjectFromFile"
git branch -d feature/project-model-t4-open
```

---

## Phase C — Integration

### Task 5: Barrel + App.vue Save/Open buttons

Wire the new helpers into the barrel and add two header buttons. Subagent does NOT do browser verification — user does that after the merge.

**Files:**
- Modify: `src/project/index.ts` (add file-io exports)
- Modify: `src/App.vue` (add buttons + handlers)

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t5-ui
```

- [ ] **Step 2: Update barrel**

In `src/project/index.ts`, append to the existing exports:

```ts
export {
  serializeProject,
  deserializeProject,
  replaceProject,
} from './storage';
export {
  saveProjectToFile,
  openProjectFromFile,
  ProjectFileError,
} from './file-io';
```

Keep all existing exports intact.

- [ ] **Step 3: Run full check after barrel only**

```bash
npx vue-tsc --noEmit && npm test
```
Expected: 143 tests pass; tsc clean.

- [ ] **Step 4: Update `src/App.vue`**

Read the current `<script setup>` block first to find where `project`, `useSynth` import, etc. are. Then:

(a) Update the existing project import to include the new helpers:

```ts
import {
  // ...existing imports kept as-is...
  saveProjectToFile,
  openProjectFromFile,
  replaceProject,
} from './project';
```

(If the existing import line is `import { clearTrack as clearProjectTrack, … } from './project'`, append the three new names to it; don't create a duplicate import line.)

(b) Add the two handlers near the existing `onClear` / `onShift` / `onFill` handlers:

```ts
const onSave = () => {
  saveProjectToFile(project);
};

const onOpen = async () => {
  try {
    const loaded = await openProjectFromFile();
    if (loaded) replaceProject(project, loaded);
  } catch (e) {
    console.warn('Open failed:', e);
    alert(`Could not open project: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};
```

(c) In the template, add two buttons in the header area (next to BPM input / Play button). Match the existing button styling — if the header uses a `<div class="controls">` or similar, drop the buttons inside it:

```vue
<button class="header-btn" @click="onSave" title="Save project to a file">Save</button>
<button class="header-btn" @click="onOpen" title="Open a project from a file">Open</button>
```

If the existing buttons in App.vue use a different class name, copy that class instead of `header-btn`. Goal: visual parity with neighbors, not a new style.

- [ ] **Step 5: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: 143 tests still pass (no new tests added in this task); tsc clean; build clean.

- [ ] **Step 6: Commit + merge sub-branch**

```bash
git add src/project/index.ts src/App.vue
git commit -m "feat(app): Save and Open buttons in the header

Save calls saveProjectToFile (picker-based). Open calls openProjectFromFile
and, on success, applies replaceProject to the live reactive root —
preserving watcher identity so the audio graph keeps running. Errors are
surfaced via a brief alert(). User browser-verification of cross-browser
picker behavior is the next gate."

git checkout feature/project-model
git merge --no-ff feature/project-model-t5-ui -m "Merge T5: Save/Open UI"
git branch -d feature/project-model-t5-ui
```

---

### Task 6: Docs update + final acceptance check

Reflect the file I/O in `ARCHITECTURE.md`; verify spec acceptance criteria; report.

**Files:**
- Modify: `docs/ARCHITECTURE.md` (update §13 "The Project module")

- [ ] **Step 1: Cut sub-branch**

```bash
git checkout feature/project-model
git checkout -b feature/project-model-t6-docs
```

- [ ] **Step 2: Update `docs/ARCHITECTURE.md` §13**

Read the existing §13 first. Append a subsection or amend prose to cover:

- `serializeProject` / `deserializeProject` — pure helpers for round-tripping the project to/from JSON. Same pipeline as `loadProject` for inputs (migrate + reconcile).
- `replaceProject(target, source)` — mutates `target` in place to match `source`. Preserves the reactive proxy identity so `buildAudioState`'s watchers don't need teardown. Used by Open.
- `saveProjectToFile` / `openProjectFromFile` (in `file-io.ts`) — feature-detect the File System Access API; fall back to download-anchor / `<input type="file">`. `ProjectFileError` wraps unreadable / future-schema cases.
- File format: plain JSON, `.json` extension, identical content to the localStorage payload. Files and localStorage are interchangeable snapshots.

One paragraph is enough. The spec at `docs/superpowers/specs/2026-05-24-project-file-io-design.md` is the long-form reference — link to it.

- [ ] **Step 3: Run full check**

```bash
npm test && npx vue-tsc --noEmit && npx vite build
```
Expected: 143 tests pass; clean.

- [ ] **Step 4: Verify acceptance criteria from spec §10**

Walk through each item; each must be ✓:

1. `src/project/file-io.ts` exists with `saveProjectToFile`, `openProjectFromFile`, `ProjectFileError`.
2. `serializeProject` / `deserializeProject` / `replaceProject` live in `storage.ts`.
3. All three are re-exported from `src/project/index.ts`.
4. App.vue has Save and Open buttons; both call into the helpers.
5. (Browser-verified by user) Save round-trips: file written, Open same file, audio/visual matches.
6. Open from a partial file fills defaults via reconciler (covered by deserializeProject tests).
7. (Browser-verified) User-cancellation of either picker is silent.
8. Open with future-schemaVersion shows user-visible error (covered by ProjectFileError test).
9. `replaceProject` preserves reactive proxy identity (covered by replaceProject tests).
10. All existing tests pass; new tests added; `vue-tsc` + `vite build` clean.
11. Documented in `docs/ARCHITECTURE.md` §13.

If any unit-testable item is ✗, halt and report. Items 5 + 7 are explicitly browser-only; mark them "pending user verification" — don't fail the task on them.

- [ ] **Step 5: Compute final stats**

```bash
git log --oneline main..feature/project-model | wc -l
git diff --stat main..feature/project-model | tail -3
npm test 2>&1 | grep -E "Tests|Test Files" | tail -2
```

Capture for the final report:
- Total commits on `feature/project-model` since `main`
- Files changed / insertions / deletions
- Final test count

- [ ] **Step 6: Commit + merge sub-branch**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: file I/O in ARCHITECTURE §13"

git checkout feature/project-model
git merge --no-ff feature/project-model-t6-docs -m "Merge T6: file I/O docs"
git branch -d feature/project-model-t6-docs
```

- [ ] **Step 7: Hand off**

Report to user:
- New tasks landed (T1–T6)
- Final test count (~143)
- All unit-testable acceptance criteria pass
- **Browser verification still owed by user** for items §10.5 + §10.7
- **Do NOT merge `feature/project-model` to `main`** — that remains the user's explicit gate.

Suggested handoff message:
> File I/O work merged into `feature/project-model` (T1–T6). `npm test` shows `<count>` passing; `vue-tsc` + `vite build` clean. Save/Open buttons added to App.vue. Ready for your browser verification — try Save in Chrome (native picker) and Safari (download), Open from a saved file, Open a corrupted file (should alert). Don't merge to `main` until you've signed off.

---

## Self-review (against spec)

### Spec coverage

| Spec section | Task(s) |
|---|---|
| §1 Goals (save .json, open .json, reuse pipeline, all browsers) | T1, T3, T4 |
| §2 Non-goals (no current-file tracking, no picker UI, no networking) | Honored throughout |
| §3 Module layout (file-io.ts, storage.ts additions, index.ts) | T3, T4, T1, T2, T5 |
| §4 Type signatures | T1 (serialize/deserialize), T2 (replace), T3 (save + Error), T4 (open) |
| §5 `replaceProject` in-place mutation semantics | T2 |
| §6 File I/O picker strategy | T3 (save), T4 (open) |
| §7 UI integration (Save/Open buttons in App.vue) | T5 |
| §8 Error handling table | T3 (save errors), T4 (open errors), T5 (alert surface) |
| §9 Testing approach (round-trip, identity, mocked pickers) | T1, T2, T3, T4 |
| §10 Acceptance criteria | T6 step 4 |
| §11 Out-of-scope reminders | None of these appear in any task |

No gaps.

### Placeholder scan

No "TBD", "TODO", "implement later", "fill in details", "add error handling" without code. Every step has the actual content the engineer needs. The phrase "verify before adding" appears in T4 step 4 — that's a real check against the file's current state, not a placeholder.

### Type consistency

- `Project`, `ProjectTrack`, `EngineParamsMap` — already established in prior plan; all imports point to `'./types'` or `'../project'`.
- `serializeProject(project: Project): string` and `deserializeProject(text: string): Project` — used consistently across T1, T3, T4.
- `replaceProject(target: Project, source: Project): void` — used consistently across T2 and T5.
- `saveProjectToFile(project: Project, suggestedName?: string): Promise<void>` — T3 / T5 match.
- `openProjectFromFile(): Promise<Project | null>` — T4 / T5 match.
- `ProjectFileError` — T3 defines, T4 throws, T5's onOpen handler catches.

No inconsistencies.

### Scope check

Single focused subsystem. Six tasks. Branch-per-task workflow. No drift into named presets, project picker UI, or networking.
