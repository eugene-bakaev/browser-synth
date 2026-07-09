# Custom Track Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can rename tracks; unnamed tracks display the live default `Track ${index + 1}`.

**Architecture:** `ProjectTrack` gains a synced `name: string` leaf (`''` = unnamed). A shared `trackDisplayName(track, index)` helper is the single source of the fallback rule. Renaming happens only in StudioView's focused header via a new small `TrackNameEditor` component that dispatches `['tracks', i, 'name']` through the existing CommandBus path. Every load/repair boundary (`normalizeProject`, client `reconcileWithDefaults`, `replaceProject`) heals/carries the field so no migration is needed.

**Tech Stack:** TypeScript, Zod, Vue 3.5 `<script setup>`, Vitest (jsdom for components).

**Source spec:** `docs/superpowers/specs/2026-07-09-track-names-design.md`

## Global Constraints

- `TRACK_NAME_MAX_LENGTH = 24` — exact value, defined once in `packages/shared/src/project/constants.ts`.
- `''` means "unnamed"; display fallback is exactly `` `Track ${index + 1}` `` (1-based, live slot number).
- Committing an empty/whitespace-only name stores `''` (revert to default) — never rejected.
- Custom names display as typed (no forced uppercase).
- **No server changes. No migration. No schemaVersion bump.**
- Rename UI lives in the focused view header ONLY (no overview double-click editing).
- Never run `npm run dev` (hits prod Supabase). Local browser testing uses `npm run dev:obs` only.
- Commits: stage only named files (never `git add -A`/`-u`; never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`). Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir
  ```

---

### Task 1: Shared model + sync path (`@fiddle/shared`)

**Files:**
- Modify: `packages/shared/src/project/types.ts` (ProjectTrack)
- Modify: `packages/shared/src/project/constants.ts`
- Modify: `packages/shared/src/project/factory.ts` (freshTrack)
- Modify: `packages/shared/src/project/schema.ts` (TrackSchema)
- Modify: `packages/shared/src/project/accept-list.ts` (PATTERNS + resolveLeafSchema)
- Modify: `packages/shared/src/project/normalize.ts` (isValidTrack + repairTrack)
- Create: `packages/shared/src/project/display.ts`
- Modify: `packages/shared/src/project/index.ts` (exports)
- Test: `packages/shared/src/project/display.test.ts` (new), plus additions to `factory.test.ts`, `schema.test.ts`, `accept-list.test.ts`, `normalize.test.ts`

**Interfaces:**
- Consumes: existing `ProjectTrack`, `Schemas.Track`, `freshTrack()`, `normalizeProject()`.
- Produces (later tasks rely on these exact names):
  - `ProjectTrack.name: string`
  - `TRACK_NAME_MAX_LENGTH = 24` (exported from `@fiddle/shared`)
  - `trackDisplayName(track: Pick<ProjectTrack, 'name'>, index: number): string` (exported from `@fiddle/shared`)
  - Writable synced path `tracks.<i>.name` (string, max 24)

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/project/display.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { trackDisplayName } from './display.js';

describe('trackDisplayName', () => {
  it('returns the custom name when set', () => {
    expect(trackDisplayName({ name: 'Bassline' }, 0)).toBe('Bassline');
  });

  it('falls back to Track N (1-based) when empty', () => {
    expect(trackDisplayName({ name: '' }, 0)).toBe('Track 1');
    expect(trackDisplayName({ name: '' }, 7)).toBe('Track 8');
  });

  it('treats whitespace-only as unnamed', () => {
    expect(trackDisplayName({ name: '   ' }, 2)).toBe('Track 3');
  });

  it('trims the displayed name', () => {
    expect(trackDisplayName({ name: '  Kick  ' }, 0)).toBe('Kick');
  });
});
```

Append to `packages/shared/src/project/factory.test.ts` (inside its existing top-level describe, or as a new describe if the file groups differently — match the file's structure):

```ts
it('fresh tracks are unnamed (name is the empty string)', () => {
  expect(freshTrack().name).toBe('');
});
```

Append to `packages/shared/src/project/schema.test.ts`:

```ts
describe('track name schema', () => {
  it('accepts a fresh track and a named track', () => {
    expect(Schemas.Track.safeParse(freshTrack()).success).toBe(true);
    expect(Schemas.Track.safeParse({ ...freshTrack(), name: 'Bassline' }).success).toBe(true);
  });

  it('rejects a name over TRACK_NAME_MAX_LENGTH', () => {
    const over = { ...freshTrack(), name: 'x'.repeat(TRACK_NAME_MAX_LENGTH + 1) };
    expect(Schemas.Track.safeParse(over).success).toBe(false);
  });

  it('rejects a non-string / missing name', () => {
    expect(Schemas.Track.safeParse({ ...freshTrack(), name: 42 }).success).toBe(false);
    const { name: _n, ...noName } = freshTrack();
    expect(Schemas.Track.safeParse(noName).success).toBe(false);
  });
});
```

(Import `freshTrack` from `./factory.js` and `TRACK_NAME_MAX_LENGTH` from `./constants.js` if the test file doesn't already.)

Append to `packages/shared/src/project/accept-list.test.ts`:

```ts
describe('tracks.*.name', () => {
  it('is writable and validates strings (including empty)', () => {
    expect(validatePathAndValue('tracks.3.name', 'Bassline')).toEqual({ ok: true });
    expect(validatePathAndValue('tracks.0.name', '')).toEqual({ ok: true });
  });

  it('nacks overlong and non-string values', () => {
    expect(validatePathAndValue('tracks.0.name', 'x'.repeat(25)))
      .toMatchObject({ ok: false, code: 'value.invalid' });
    expect(validatePathAndValue('tracks.0.name', 42))
      .toMatchObject({ ok: false, code: 'value.invalid' });
  });

  it('still rejects out-of-range track indices', () => {
    expect(validatePathAndValue('tracks.99.name', 'x'))
      .toMatchObject({ ok: false, code: 'path.invalid' });
  });
});
```

Append to `packages/shared/src/project/normalize.test.ts`:

```ts
describe('track name healing', () => {
  it('fills a missing name with the empty string (old sessions)', () => {
    const p = freshProject();
    delete (p.tracks[0] as { name?: string }).name;
    const out = normalizeProject(p);
    expect(out).not.toBe(p); // fast path must reject a name-less track
    expect(out.tracks[0].name).toBe('');
  });

  it('keeps present names untouched and passes the fast path', () => {
    const p = freshProject();
    p.tracks[2].name = 'Lead';
    const out = normalizeProject(p);
    expect(out).toBe(p); // still valid → by-reference fast path
    expect(out.tracks[2].name).toBe('Lead');
  });

  it('replaces a non-string name with the empty string', () => {
    const p = freshProject();
    (p.tracks[1] as unknown as { name: unknown }).name = 42;
    expect(normalizeProject(p).tracks[1].name).toBe('');
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/project/display.test.ts src/project/factory.test.ts src/project/schema.test.ts src/project/accept-list.test.ts src/project/normalize.test.ts`

Expected: display.test fails to resolve `./display.js`; the appended factory/schema/accept-list/normalize tests FAIL (`name` undefined / path not writable / fast path returns by reference).

- [ ] **Step 3: Implement the shared model**

`packages/shared/src/project/constants.ts` — append:

```ts
// Custom track name length cap (chars). '' = unnamed — every label site
// falls back to the live default `Track ${index + 1}` (trackDisplayName).
export const TRACK_NAME_MAX_LENGTH = 24;
```

`packages/shared/src/project/types.ts` — in `ProjectTrack`, after `engineType`:

```ts
  // Custom track name. '' = unnamed — the UI falls back to the live default
  // `Track ${index + 1}` (see trackDisplayName in display.ts). Max length is
  // TRACK_NAME_MAX_LENGTH, enforced by TrackSchema on the wire.
  name: string;
```

`packages/shared/src/project/factory.ts` — in `freshTrack()`, after `engineType: 'synth',`:

```ts
    name: '',
```

`packages/shared/src/project/schema.ts` — add `TRACK_NAME_MAX_LENGTH` to the existing `./constants.js` import, and in `TrackSchema` after `engineType`:

```ts
  // '' = unnamed (display fallback lives in trackDisplayName, not here).
  name: z.string().max(TRACK_NAME_MAX_LENGTH),
```

Create `packages/shared/src/project/display.ts`:

```ts
import type { ProjectTrack } from './types.js';

// Single source of the track-label fallback rule: a track with an empty (or
// whitespace-only) custom name displays the live default `Track ${index + 1}`
// (`index` is the 0-based pool index). Every label site in the client goes
// through this helper so the rule can never fork.
export function trackDisplayName(track: Pick<ProjectTrack, 'name'>, index: number): string {
  const trimmed = track.name.trim();
  return trimmed !== '' ? trimmed : `Track ${index + 1}`;
}
```

`packages/shared/src/project/accept-list.ts` — in `PATTERNS`, after the `['tracks', '*', 'enabled'],` row:

```ts
  ['tracks', '*', 'name'],
```

and in `resolveLeafSchema`, after the `enabled` branch:

```ts
  if (trackKey === 'name' && tokens.length === 3) {
    return trackShape.name;
  }
```

`packages/shared/src/project/normalize.ts` — in `isValidTrack`, add as the first condition:

```ts
    typeof t.name === 'string' &&
```

and in `repairTrack`'s return object, after the `...t,` spread line:

```ts
    name: typeof t.name === 'string' ? t.name : '',
```

`packages/shared/src/project/index.ts` — add `TRACK_NAME_MAX_LENGTH` to the constants export block, and after the factory export line:

```ts
export { trackDisplayName } from './display.js';
```

- [ ] **Step 4: Run the full shared suite + typecheck**

Run: `cd packages/shared && npx vitest run && npx tsc --noEmit`

Expected: PASS. If any existing test builds a track literal without `name` and asserts it schema-valid or normalize-fast-path-valid, that fixture now legitimately needs `name: ''` — fix the fixture, nothing else.

Also typecheck dependents (the required `name` field can surface missing-property errors in fixtures there): `cd ../client && npx vue-tsc --noEmit` and `cd ../server && npx tsc --noEmit`. Client/server PRODUCTION code needs no changes — only test fixtures constructing raw `ProjectTrack` literals may need `name: ''` added.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/types.ts packages/shared/src/project/constants.ts packages/shared/src/project/factory.ts packages/shared/src/project/schema.ts packages/shared/src/project/accept-list.ts packages/shared/src/project/normalize.ts packages/shared/src/project/display.ts packages/shared/src/project/index.ts packages/shared/src/project/display.test.ts packages/shared/src/project/factory.test.ts packages/shared/src/project/schema.test.ts packages/shared/src/project/accept-list.test.ts packages/shared/src/project/normalize.test.ts
git commit -m "feat(shared): ProjectTrack.name — synced track-name leaf + trackDisplayName fallback"
```

(Plus any fixture files Step 4 required — stage them by name.)

---

### Task 2: Client offline/replace boundaries

**Files:**
- Modify: `packages/client/src/project/storage.ts` (`reconcileTrack`, `replaceProject`)
- Test: `packages/client/src/project/storage.test.ts`

**Interfaces:**
- Consumes: `ProjectTrack.name: string` from Task 1 (via `@fiddle/shared`).
- Produces: `reconcileWithDefaults` output always carries a string `name`; `replaceProject(target, source)` copies `name` per slot. No new exports.

Why this task exists: `reconcileWithDefaults` is the OFFLINE repair boundary (localStorage / .prj.json file open). Without it, opening an old exported file would send the server a `load` payload whose tracks lack `name` → `Schemas.Project.safeParse` nacks the whole load (TrackSchema.name is required). `replaceProject` applies incoming snapshots onto the reactive store — without copying `name`, a collaborator's rename (or your own, after reload) would never reach the UI.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/project/storage.test.ts` (it already imports `reconcileWithDefaults` and `replaceProject`; import `freshProject` from `./factory` if not present):

```ts
describe('track name at the offline boundary', () => {
  it('reconcileWithDefaults fills a missing name with the empty string', () => {
    const p = freshProject();
    delete (p.tracks[0] as { name?: string }).name;
    const out = reconcileWithDefaults(JSON.parse(JSON.stringify(p)));
    expect(out.tracks[0].name).toBe('');
  });

  it('reconcileWithDefaults keeps a stored name', () => {
    const p = freshProject();
    p.tracks[1].name = 'Bassline';
    const out = reconcileWithDefaults(JSON.parse(JSON.stringify(p)));
    expect(out.tracks[1].name).toBe('Bassline');
  });

  it('replaceProject copies name across slots', () => {
    const target = freshProject();
    const source = freshProject();
    source.tracks[3].name = 'Perc';
    replaceProject(target, source);
    expect(target.tracks[3].name).toBe('Perc');
    expect(target.tracks[0].name).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/client && npx vitest run src/project/storage.test.ts`

Expected: the two heal/copy tests FAIL (`name` is `undefined` after reconcile; `replaceProject` doesn't carry it).

- [ ] **Step 3: Implement**

`packages/client/src/project/storage.ts` — in `reconcileTrack`'s `reconciled` object, after `engineType: …,`:

```ts
    // Same rule as normalizeProject on the sync boundary: a stored string
    // wins, anything else (old file, hand-edited JSON) heals to '' = unnamed.
    name: typeof t.name === 'string' ? t.name : '',
```

and in `replaceProject`, next to `t.engineType = s.engineType;`:

```ts
    t.name = s.name;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && npx vitest run src/project/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/project/storage.ts packages/client/src/project/storage.test.ts
git commit -m "feat(client): carry track name through offline reconcile + snapshot replace"
```

---

### Task 3: Rename UI — TrackNameEditor + label sites

**Files:**
- Create: `packages/client/src/components/TrackNameEditor.vue`
- Test: `packages/client/src/components/TrackNameEditor.test.ts`
- Modify: `packages/client/src/views/StudioView.vue` (focused header ~line 85, overview `:title` ~line 51, focused `:title` ~line 176, remove-dialog message ~line 431)
- Modify: `packages/client/src/components/TrackMixer.vue` (`TRK N` label, ~line 31)

**Interfaces:**
- Consumes: `trackDisplayName`, `TRACK_NAME_MAX_LENGTH` from `@fiddle/shared` (Task 1); existing `dispatchLocal(path: (string|number)[], value: unknown)` from the injected `SYNTH_CONTEXT`.
- Produces: `TrackNameEditor.vue` — props `{ name: string; displayName: string }`, emits `commit(value: string)` (already trimmed; `''` = revert to default).

- [ ] **Step 1: Write the failing component test**

Create `packages/client/src/components/TrackNameEditor.test.ts` (mount pattern copied from `Tracker.test.ts`; `onCommit` prop is how `createApp` wires an emit listener):

```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import TrackNameEditor from './TrackNameEditor.vue';
import { TRACK_NAME_MAX_LENGTH } from '@fiddle/shared';

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

function mountEditor(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(TrackNameEditor, props);
  app.mount(host);
  return host;
}

function label(el: HTMLElement): HTMLElement | null {
  return el.querySelector('.track-name-label');
}
function input(el: HTMLElement): HTMLInputElement | null {
  return el.querySelector('.track-name-input');
}

async function beginEdit(el: HTMLElement): Promise<HTMLInputElement> {
  label(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
  const inp = input(el);
  expect(inp).not.toBeNull();
  return inp!;
}

async function type(inp: HTMLInputElement, value: string): Promise<void> {
  inp.value = value;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

describe('TrackNameEditor', () => {
  it('idle: renders displayName as a label, no input', () => {
    const el = mountEditor({ name: '', displayName: 'Track 1', onCommit: vi.fn() });
    expect(label(el)!.textContent).toContain('Track 1');
    expect(input(el)).toBeNull();
  });

  it('click begins editing, prefilled with the RAW name (empty when unnamed)', async () => {
    const el = mountEditor({ name: '', displayName: 'Track 1', onCommit: vi.fn() });
    const inp = await beginEdit(el);
    expect(inp.value).toBe('');
    expect(inp.maxLength).toBe(TRACK_NAME_MAX_LENGTH);
  });

  it('Enter commits the trimmed value and closes the editor', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: 'Old', displayName: 'Old', onCommit });
    const inp = await beginEdit(el);
    await type(inp, '  Bassline  ');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Bassline');
    expect(input(el)).toBeNull();
  });

  it('blur commits', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: '', displayName: 'Track 1', onCommit });
    const inp = await beginEdit(el);
    await type(inp, 'Lead');
    inp.dispatchEvent(new FocusEvent('blur'));
    await nextTick();
    expect(onCommit).toHaveBeenCalledWith('Lead');
  });

  it('Escape cancels without emitting (and the follow-up blur stays silent)', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: 'Keep me', displayName: 'Keep me', onCommit });
    const inp = await beginEdit(el);
    await type(inp, 'discarded');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    inp.dispatchEvent(new FocusEvent('blur'));
    await nextTick();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input(el)).toBeNull();
  });

  it('committing whitespace emits the empty string (revert to default)', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: 'Old', displayName: 'Old', onCommit });
    const inp = await beginEdit(el);
    await type(inp, '   ');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(onCommit).toHaveBeenCalledWith('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/client && npx vitest run src/components/TrackNameEditor.test.ts`
Expected: FAIL — cannot resolve `./TrackNameEditor.vue`.

- [ ] **Step 3: Implement the component**

Create `packages/client/src/components/TrackNameEditor.vue`:

```vue
<!--
  Click-to-edit track name (focused-view header). Shows the resolved display
  label when idle; click swaps in a text input prefilled with the RAW custom
  name ('' when unnamed). Enter/blur commit the trimmed draft ('' = revert to
  the `Track N` default); Escape cancels. The parent owns persistence — this
  component only emits.
-->
<template>
  <span
    v-if="!editing"
    class="track-name-label"
    title="Click to rename"
    @click="beginEdit"
  >{{ displayName }}</span>
  <input
    v-else
    ref="inputEl"
    v-model="draft"
    class="track-name-input"
    type="text"
    :maxlength="TRACK_NAME_MAX_LENGTH"
    @keydown.enter.prevent="commit"
    @keydown.esc.prevent="cancel"
    @blur="commit"
  />
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { TRACK_NAME_MAX_LENGTH } from '@fiddle/shared';

const props = defineProps<{
  // Raw custom name ('' = unnamed) — what the editor prefills with.
  name: string;
  // Resolved label (custom name or `Track N` fallback) — what idle shows.
  displayName: string;
}>();

const emit = defineEmits<{ commit: [value: string] }>();

const editing = ref(false);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

async function beginEdit(): Promise<void> {
  draft.value = props.name;
  editing.value = true;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
}

function commit(): void {
  // Enter commits then the input unmounts and fires blur; Escape flips
  // `editing` before its blur too — this guard makes both single-shot.
  if (!editing.value) return;
  editing.value = false;
  emit('commit', draft.value.trim());
}

function cancel(): void {
  editing.value = false; // no emit; the commit() guard swallows the blur
}
</script>

<style scoped>
.track-name-label {
  cursor: text;
  border-bottom: 1px dotted transparent;
}
.track-name-label:hover {
  border-bottom-color: currentColor;
}
.track-name-input {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid currentColor;
  border-radius: 3px;
  color: inherit;
  font: inherit;
  padding: 0 6px;
  width: 14ch;
}
.track-name-input:focus {
  outline: none;
}
</style>
```

- [ ] **Step 4: Run the component test**

Run: `cd packages/client && npx vitest run src/components/TrackNameEditor.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Wire the label sites**

`packages/client/src/views/StudioView.vue`:

1. Add imports (with the other component imports / shared imports in `<script setup>`):

```ts
import TrackNameEditor from '../components/TrackNameEditor.vue';
import { trackDisplayName } from '@fiddle/shared';
```

2. Overview Tracker card title (~line 51) — replace

```
            :title="`Track ${entry.index + 1}`"
```

with

```
            :title="trackDisplayName(entry.track, entry.index)"
```

3. Focused header `<h2>` (~line 85) — replace

```
        <h2 :style="{ color: trackColor(activeTrackIndex) }">
          Editing: Track {{ activeTrackIndex + 1 }} ({{ focusedTrack!.engineType.toUpperCase() }})
        </h2>
```

with

```
        <h2 :style="{ color: trackColor(activeTrackIndex) }">
          Editing:
          <TrackNameEditor
            :name="focusedTrack!.name"
            :displayName="trackDisplayName(focusedTrack!, activeTrackIndex)"
            @commit="renameTrack"
          />
          ({{ focusedTrack!.engineType.toUpperCase() }})
        </h2>
```

4. Focused Tracker title (~line 176) — replace

```
              :title="`Track ${activeTrackIndex + 1}`"
```

with

```
              :title="trackDisplayName(focusedTrack!, activeTrackIndex)"
```

5. Add the commit handler next to `setEngineType` (~line 422):

```ts
function renameTrack(value: string): void {
  if (activeTrackIndex.value === null) return;
  dispatchLocal(['tracks', activeTrackIndex.value, 'name'], value);
}
```

6. Remove-confirm dialog (~line 431) — replace

```ts
    message: `Remove Track ${index + 1}? Its pattern and sound settings will be cleared.`,
```

with

```ts
    message: `Remove ${trackDisplayName(project.tracks[index], index)}? Its pattern and sound settings will be cleared.`,
```

`packages/client/src/components/TrackMixer.vue` — replace (~line 31)

```
            <span class="track-number">TRK {{ chan.index + 1 }}</span>
```

with

```
            <span class="track-number">{{ trackDisplayName(chan.track, chan.index) }}</span>
```

and add `trackDisplayName` to the component's `@fiddle/shared` import in `<script setup>` (add a new import line if none exists).

- [ ] **Step 6: Full client gate**

Run: `cd packages/client && npx vitest run && npx vue-tsc --noEmit && npx vite build`
Expected: full suite PASS, typecheck clean, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/TrackNameEditor.vue packages/client/src/components/TrackNameEditor.test.ts packages/client/src/views/StudioView.vue packages/client/src/components/TrackMixer.vue
git commit -m "feat(client): rename tracks from the focused header; labels fall back to Track N"
```

---

### Final gate (controller, after all tasks)

1. `cd packages/shared && npx vitest run && npx tsc --noEmit`
2. `cd packages/client && npx vitest run && npx vue-tsc --noEmit && npx vite build`
3. `cd packages/server && npx vitest run` (no server code change — regression only)
4. Mandatory browser verification on `npm run dev:obs` (throwaway session): focus a track → click the header name → rename → Enter; confirm the focused header, overview card title, and remove-dialog text all show the custom name; reload the page and confirm the name persists; clear the name (empty commit) and confirm the label reverts to `Track N`; Esc cancels; clean console; close the browser.

### Out of scope (do not build)

- Overview double-click renaming, name uniqueness, uppercasing, server changes, migrations.
