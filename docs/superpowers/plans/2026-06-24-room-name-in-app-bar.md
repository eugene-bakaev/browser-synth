# Room Name in App-Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current room's name in the top app-bar (left side) as a static label whenever a room is open.

**Architecture:** Add a passive `sessionName` ref to the shared synth context. The App shell (`App.vue`) loads the name via `getSession()` whenever `currentRoomId` changes, and renders it in the app-bar left group. The SESSION settings modal updates the ref after a local rename. No schema, sync-protocol, or audio changes.

**Tech Stack:** Vue 3 (`<script setup>`, Composition API), TypeScript, Vitest, Playwright MCP (browser verification).

**Spec:** `docs/superpowers/specs/2026-06-24-room-name-in-app-bar-design.md`

## Global Constraints

- Never edit/commit on `main` — this work is on branch `feat/room-name-in-bar` (already created).
- Fallback for an empty title is the exact string `Untitled session` (matches `LobbyView.vue`).
- `sessionName` semantics: `null` = not loaded / no room (render nothing); `''` = loaded but untitled (render fallback); non-empty = the room name.
- The label is **static** (not a button); renaming stays in the SESSION modal.
- Remote renames by other peers do NOT live-update the bar (out of scope).
- Verification commands (run from repo root `/Users/eugenebakaev/Development/browser-synth`):
  - Client unit tests: `npm run test:client`
  - Client typecheck: `npm run typecheck:client`
- `App.vue` and `StudioView.vue` have no unit-test harness; their test cycle is typecheck + the mandatory Playwright MCP browser pass. Close the browser when done (AGENTS.md rule).

---

### Task 1: Expose `sessionName` on the synth context

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts` (add module ref near `currentRoomId` ~line 172; add to the `return {…}` object ~line 910)
- Test: `packages/client/src/composables/useSynth.test.ts`

**Interfaces:**
- Produces: `sessionName: Ref<string | null>` on the object returned by `useSynth()` and on `SynthContext`. Initial value `null`. Passive — `useSynth` never mutates it; the shell and StudioView do.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing top-level `describe` block in `packages/client/src/composables/useSynth.test.ts` (near the `connectToSession` tests, e.g. after the test at line ~586):

```ts
it('exposes a passive sessionName ref defaulting to null', () => {
  const synth = useSynth();
  expect(synth.sessionName.value).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:client -- -t "passive sessionName"`
Expected: FAIL — `synth.sessionName` is `undefined`, so `.value` throws / assertion fails.

- [ ] **Step 3: Add the ref and export it**

In `packages/client/src/composables/useSynth.ts`, add the ref directly below the `currentRoomId` declaration (~line 172):

```ts
// The current room's display name, loaded by the App shell from getSession()
// whenever currentRoomId changes. null = not loaded / no room; '' = loaded but
// untitled. Rendered (static) in the top app-bar; updated after a local rename.
const sessionName = ref<string | null>(null);
```

Then add `sessionName,` to the `return { … }` object (~line 910), next to `currentRoomId`:

```ts
    currentRoomId,
    sessionName,
    connectToSession,
    leaveSession,
```

- [ ] **Step 4: Run the test + typecheck to verify they pass**

Run: `npm run test:client -- -t "passive sessionName"`
Expected: PASS

Run: `npm run typecheck:client`
Expected: no errors (the `SynthContext` type is `ReturnType<typeof useSynth>`, so the new field flows through automatically).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(room-name): expose sessionName on synth context"
```

---

### Task 2: Load + render the room name in the App shell

**Files:**
- Modify: `packages/client/src/App.vue` (template app-bar ~lines 4-16; script ~lines 28-51; scoped styles ~lines 178-195)

**Interfaces:**
- Consumes: `synth.currentRoomId` (`Ref<string|null>`), `synth.sessionName` (`Ref<string|null>`) from Task 1; `getSession(id): Promise<SessionMeta | null>` from `./sync/sessionsApi`.
- Produces: the visible app-bar label (no exported symbols).

- [ ] **Step 1: Add imports + computed + loader watcher (script)**

In `packages/client/src/App.vue`, update the `vue` import to include `computed`, and add the `getSession` import:

```ts
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
```

```ts
import { getSession } from './sync/sessionsApi';
```

Then, after the existing `provide(...)` lines (~line 44), add the derived display state:

```ts
// Room name shown (static) in the app-bar left group. Visible only once loaded
// for the current room; falls back to "Untitled session" for an empty title.
const showRoomName = computed(
  () => synth.currentRoomId.value !== null && synth.sessionName.value !== null,
);
const roomLabel = computed(() => synth.sessionName.value || 'Untitled session');
```

Then, after the existing `route`/`router` setup (~line 51), add the loader watcher:

```ts
// Load the room name whenever the connected room changes (covers deep-link,
// lobby join, and room switch — all funnel through currentRoomId). The fetch
// lives here in the shell, not in connectToSession, to keep the sync-critical
// connect path free of HTTP. Race-guarded against a room switch mid-fetch.
watch(
  () => synth.currentRoomId.value,
  async (id) => {
    if (id === null) { synth.sessionName.value = null; return; }
    synth.sessionName.value = null; // clear any stale name during load
    try {
      const m = await getSession(id);
      if (synth.currentRoomId.value === id) synth.sessionName.value = m?.name ?? '';
    } catch {
      // Non-critical: leave null (render nothing) rather than guess a title.
    }
  },
);
```

- [ ] **Step 2: Render the name in the app-bar (template)**

In `packages/client/src/App.vue`, replace the app-bar `<header>` block (~lines 4-16) so the hamburger and room name share a left group, with the teleport target staying on the right:

```html
  <header class="app-bar">
    <div class="app-bar-left">
      <button
        class="hamburger"
        :aria-expanded="sidebarOpen"
        aria-label="Open navigation"
        @click="sidebarOpen = true"
      >
        ☰
      </button>
      <span v-if="showRoomName" class="room-name" :title="roomLabel">{{ roomLabel }}</span>
    </div>
    <!-- Per-page actions (e.g. StudioView's transport) teleport in here, so the
         top bar spans the full width with the hamburger left and page controls right. -->
    <div id="app-bar-actions" class="app-bar-actions"></div>
  </header>
```

- [ ] **Step 3: Add scoped styles**

In `packages/client/src/App.vue`, inside the `<style scoped>` block, add directly after the `.app-bar-actions` rule (~line 195):

```css
.app-bar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0; /* allow the room name to truncate instead of pushing layout */
}
.room-name {
  font-family: monospace;
  font-size: 0.9rem;
  letter-spacing: 0.03em;
  color: #ccc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 36ch;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:client`
Expected: no errors.

- [ ] **Step 5: Browser verify (Playwright MCP)**

Start the dev server (`npm run dev` from repo root) and drive a browser via Playwright MCP. Check the console stays clean and:

1. From the lobby, create or open a **named** session → its name appears in the top-left of the app-bar.
2. Open an **unnamed** session (or create one with a blank name) → the bar shows `Untitled session`.
3. Deep-link reload on `/r/<id>` of a named room → name appears after load (no permanent blank).
4. While in the lobby, the app-bar shows **no** room name.
5. Click **LEAVE** → returns to lobby and the name clears.

Close the browser when done.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/App.vue
git commit -m "feat(room-name): load + render room name in app-bar"
```

---

### Task 3: Update the bar after a local rename

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (`saveMeta`, ~lines 440-462)

**Interfaces:**
- Consumes: `synth.sessionName` (Task 1), already-available `synth` from `inject(SYNTH_CONTEXT)`; existing `metaName` ref and `patchSession` call.
- Produces: nothing exported — keeps the app-bar label in sync with a successful local rename.

- [ ] **Step 1: Set sessionName after a successful patch**

In `packages/client/src/views/StudioView.vue`, in `saveMeta`, immediately after the `await patchSession(...)` call succeeds and before `showSettings.value = false;` (~line 456), add:

```ts
    // Reflect the rename in the app-bar immediately (the shell only refetches on
    // room change, not on edits).
    synth!.sessionName.value = metaName.value.trim();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:client`
Expected: no errors.

- [ ] **Step 3: Browser verify (Playwright MCP)**

With the dev server running, drive a browser via Playwright MCP (console clean):

1. Open a session you own → note the name in the app-bar.
2. Open **SESSION** settings, change the **Name**, click **Save**.
3. The modal closes and the app-bar label updates to the new name immediately (no reload).

Close the browser when done.

- [ ] **Step 4: Full regression + commit**

Run: `npm run test:client`
Expected: PASS (full client suite — no regressions).

Run: `npm run typecheck:client`
Expected: no errors.

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(room-name): keep app-bar name fresh after local rename"
```

---

## Self-Review

**Spec coverage:**
- "Shared state `sessionName: Ref<string | null>`" → Task 1. ✓
- "Loading the name in the App shell" (watcher, race guard, every entry path) → Task 2 Step 1. ✓
- "Rendering app-bar left, gated, fallback, truncation, static" → Task 2 Steps 2-3. ✓
- "Keep fresh on rename" → Task 3. ✓
- Non-goals (no remote live-update, not clickable) → respected; no task adds them. ✓
- Edge cases (lobby = nothing, loading = nothing, empty = fallback, fetch fail = null, race guard, leave clears) → covered by Task 2 watcher logic + Task 2 Step 5 browser checks. ✓
- Verification (unit suite green + browser pass) → Task 3 Step 4 + Task 2/3 browser steps. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows actual code. ✓

**Type consistency:** `sessionName` is `Ref<string | null>` everywhere; `getSession(id): Promise<SessionMeta | null>` matches `sessionsApi.ts`; `roomLabel`/`showRoomName` computed names are consistent between script and template; `metaName` matches StudioView's existing ref. ✓
