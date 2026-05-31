# UI Shell, Sidebar & Account Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move navigation and identity/presence into a persistent left sidebar, add a real Account page reached via `vue-router`, and relocate the username editor there — without dropping audio or the WebSocket connection on navigation.

**Architecture:** `App.vue` becomes a never-unmounting shell that calls `useSynth()` exactly once, provides it via a typed injection key, and renders `<Sidebar/>` + `<router-view/>`. The current studio UI moves verbatim into a `StudioView` route that injects that context; a new `AccountView` route hosts the username editor and identity readout. Audio/sequencer/WS already live at module scope in `useSynth`, so a once-instantiated shell keeps them alive across route changes.

**Tech Stack:** Vue 3 (`^3.4.0`), `vue-router` (new), TypeScript, Vite, Vitest (`vitest run`), Supabase auth singleton.

**Verification convention:** The project has **no `@vue/test-utils`**; the convention is to unit-test logic/composables, not mount `.vue` files (see the spec's Testing section — this overrides default TDD-for-everything). Logic changes (Task 2 `useAuth` widening, Task 4 router table) get real Vitest tests. Pure UI/structural tasks are verified by `typecheck` + `build` staying green and by manual browser checks, which is the established split in this repo. Do **not** introduce a component-test harness.

Commands used throughout (run from repo root `/Users/eugenebakaev/Development/browser-synth`):
- Client typecheck: `npm run typecheck:client`
- Client tests: `npm run test:client`
- Client build: `npm run build:client`
- Full gate: `npm run typecheck && npm test && npm run build`

Baseline before starting: client 231 tests passing; full suite 320.

---

### Task 1: Add `vue-router` dependency + `SYNTH_CONTEXT` injection key

**Files:**
- Modify: `packages/client/package.json` (dependencies)
- Create: `packages/client/src/sync/synthContext.ts`

- [ ] **Step 1: Add the dependency**

Run from repo root:
```bash
npm install vue-router@^4.3.0 -w @fiddle/client
```
Expected: `vue-router` appears under `dependencies` in `packages/client/package.json`; root `package-lock.json` updates. (npm only — never pnpm.)

- [ ] **Step 2: Create the typed injection key**

Create `packages/client/src/sync/synthContext.ts`:
```ts
// Injection key carrying the single useSynth() instance from the App shell down
// to the StudioView route. useSynth() must be called exactly once (its
// currentStep/activeTrackIndex are per-call refs), so the shell owns the call
// and provides the result here; StudioView injects it instead of calling
// useSynth() itself.
import type { InjectionKey } from 'vue';
import type { useSynth } from '../composables/useSynth';

export type SynthContext = ReturnType<typeof useSynth>;

export const SYNTH_CONTEXT: InjectionKey<SynthContext> = Symbol('synthContext');
```

- [ ] **Step 3: Verify typecheck + build still pass**

Run: `npm run typecheck:client && npm run build:client`
Expected: both succeed. The new export is unused for now — that is fine.

- [ ] **Step 4: Commit**

```bash
git add packages/client/package.json package-lock.json packages/client/src/sync/synthContext.ts
git commit -m "feat(client): add vue-router dep + SYNTH_CONTEXT injection key

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Widen `useAuth` to expose the user profile (email/name/avatar)

**Files:**
- Modify: `packages/client/src/auth/useAuth.ts`
- Test: `packages/client/src/auth/useAuth.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('useAuth', ...)` block in `packages/client/src/auth/useAuth.test.ts` (after the last test, before the closing `});`). Also add the named import of the pure helper to the existing import line.

Change the import line near the top:
```ts
import { useAuth, userProfileFromSession } from './useAuth';
```

Add the tests:
```ts
  it('userProfileFromSession extracts email/name/avatar, null when absent', () => {
    expect(userProfileFromSession(null)).toEqual({
      email: null,
      name: null,
      avatarUrl: null,
    });
    expect(
      userProfileFromSession({
        user: {
          id: 'u-1',
          email: 'a@b.com',
          user_metadata: { name: 'Ada', avatar_url: 'http://x/a.png' },
        },
        access_token: 'tok',
      }),
    ).toEqual({ email: 'a@b.com', name: 'Ada', avatarUrl: 'http://x/a.png' });
  });

  it('exposes a reactive userProfile from the session', async () => {
    const auth = useAuth();
    await auth.ready;
    expect(auth.userProfile.value).toEqual({ email: null, name: null, avatarUrl: null });
    h.cb.current?.('SIGNED_IN', {
      user: {
        id: 'u-1',
        email: 'a@b.com',
        user_metadata: { name: 'Ada', avatar_url: 'http://x/a.png' },
      },
      access_token: 'tok-1',
    });
    expect(auth.userProfile.value).toEqual({
      email: 'a@b.com',
      name: 'Ada',
      avatarUrl: 'http://x/a.png',
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:client -- useAuth`
Expected: FAIL — `userProfileFromSession` is not exported and `auth.userProfile` is undefined.

- [ ] **Step 3: Implement the widening**

In `packages/client/src/auth/useAuth.ts`:

(a) Widen the `SessionLike` interface (currently lines 7–10):
```ts
interface SessionLike {
  user: {
    id: string;
    email?: string;
    user_metadata?: { name?: string; avatar_url?: string };
  };
  access_token: string;
}
```

(b) Add the pure helper + `UserProfile` type just below the `SetUsernameResult` type export (after line 14):
```ts
export interface UserProfile {
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

// Pure projection of a session into display fields. Exported for unit testing.
export function userProfileFromSession(s: SessionLike | null): UserProfile {
  return {
    email: s?.user.email ?? null,
    name: s?.user.user_metadata?.name ?? null,
    avatarUrl: s?.user.user_metadata?.avatar_url ?? null,
  };
}
```

(c) Add a computed next to the existing `accessToken` computed (after line 28):
```ts
const userProfile = computed(() => userProfileFromSession(session.value));
```

(d) Add `userProfile` to the returned object in `useAuth()` (the `return { ... }` near line 59):
```ts
  return { ready, isAuthenticated, accessToken, userProfile, session, signInWithGoogle, signOut, setUsername };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:client -- useAuth`
Expected: PASS — all useAuth tests green, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/auth/useAuth.ts packages/client/src/auth/useAuth.test.ts
git commit -m "feat(client): expose userProfile (email/name/avatar) from useAuth

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Extract `StudioView` from `App.vue`; shell renders it directly

This moves today's entire studio UI into a route component and turns `App.vue` into a thin shell. No router yet — the shell renders `<StudioView/>` directly so the app behaves identically.

**Files:**
- Create: `packages/client/src/views/StudioView.vue`
- Modify: `packages/client/src/App.vue`

- [ ] **Step 1: Create `StudioView.vue` with the moved template**

Create `packages/client/src/views/StudioView.vue`. Its `<template>` is the **current `App.vue` template with the `<ErrorOverlay />` line removed** (ErrorOverlay moves to the shell). That is, the root of StudioView's template is `<div class="synth-container"> … </div>` containing the existing `<header>`, the overview block (`v-if="activeTrackIndex === null"`), the focused block (`v-else`), and the `<div class="mixer-section">` — copied verbatim from the current `App.vue` lines 3–179.

Its `<script setup lang="ts">` is the current `App.vue` script (lines 182–290) with two changes:
1. Replace the `useSynth()` import + call with an inject of `SYNTH_CONTEXT`.
2. Remove the `provide(ACTIVE_TRACK_KEY, …)` call and its import (that provide moves to the shell in Step 2).

Resulting `<script setup>` head for StudioView (everything from `const onClear = …` downward stays identical to current `App.vue`):
```ts
import { computed, inject } from 'vue';
import { SYNTH_CONTEXT } from '../sync/synthContext';
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
  resetEnginePatch,
} from '../project';
import Tracker from '../components/Tracker.vue';
import RoomBar from '../components/RoomBar.vue';
import SynthPanel from '../components/SynthPanel.vue';
import KickPanel from '../components/KickPanel.vue';
import HatPanel from '../components/HatPanel.vue';
import SnarePanel from '../components/SnarePanel.vue';
import ClapPanel from '../components/ClapPanel.vue';
import TrackMixer from '../components/TrackMixer.vue';

const synth = inject(SYNTH_CONTEXT);
if (!synth) throw new Error('SYNTH_CONTEXT not provided');
const {
  project,
  trackAnalysers,
  sequencer,
  bpm,
  activeTrackIndex,
  focusedTrack,
  currentStep,
  waveforms,
  shortestActiveNoteDuration,
  togglePlay,
  selectTrack,
  getTrackEngineType,
} = synth;

const activeAnalyser = computed(() =>
  trackAnalysers.value?.[activeTrackIndex.value ?? 0] ?? null
);
```
Then paste, unchanged, the rest of the current `App.vue` script: `onClear`, `onShift`, `onFill`, `onSetLength`, `onNew`, `onSave`, `onOpen`, `onSavePreset`, `onLoadPreset`, `onInitPatch`, and `const TRACK_COLORS = ['#00f0ff', '#c084fc', '#fb923c', '#4ade80'];`.

Note the import paths changed from `./` to `../` because the file moved into `views/`.

StudioView's `<style>` blocks: **move the entire scoped `<style scoped>` block from the current `App.vue` (lines 382–607) into StudioView verbatim.** Leave the unscoped global `<style>` block (lines 307–380) in `App.vue` (Step 2) — child panels depend on it across component boundaries.

- [ ] **Step 2: Slim `App.vue` down to the shell (no router yet)**

Replace `App.vue` so its `<template>`, `<script setup>` become:
```vue
<template>
  <ErrorOverlay />
  <StudioView />
</template>

<script setup lang="ts">
import { provide } from 'vue';
import { useSynth } from './composables/useSynth';
import { ACTIVE_TRACK_KEY } from './sync/knobSync';
import { SYNTH_CONTEXT } from './sync/synthContext';
import ErrorOverlay from './components/ErrorOverlay.vue';
import StudioView from './views/StudioView.vue';

// useSynth() is called exactly once here, in the never-unmounting shell, so its
// per-call currentStep/activeTrackIndex are stable and audio/WS (module-scope)
// survive any future navigation.
const synth = useSynth();
provide(SYNTH_CONTEXT, synth);
provide(ACTIVE_TRACK_KEY, synth.activeTrackIndex);
</script>
```
Keep the **unscoped** `<style>` block (the global design system: `body`, `h1`, `.module-group`, `.knob-row`, `.rack-columns`, `.rack-column`, `.engine-section .module-group` hover — current lines 307–380) in `App.vue` unchanged. Delete the scoped block from `App.vue` (it now lives in StudioView). Retain the explanatory comment above the styles.

- [ ] **Step 3: Verify typecheck + build + browser parity**

Run: `npm run typecheck:client && npm run build:client`
Expected: both succeed, no type errors.

Manual (user): `npm run dev`, open http://localhost:5173 — the app looks and behaves exactly as before (overview, focus a track, transport, mixer, RoomBar in header all work; audio plays).

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/App.vue packages/client/src/views/StudioView.vue
git commit -m "refactor(client): extract StudioView from App.vue shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Add the router with `/studio` + `/account`

**Files:**
- Create: `packages/client/src/router/index.ts`
- Create: `packages/client/src/views/AccountView.vue` (minimal placeholder; fleshed out in Task 5)
- Create: `packages/client/src/router/index.test.ts`
- Modify: `packages/client/src/main.ts`
- Modify: `packages/client/src/App.vue`

- [ ] **Step 1: Write the failing router test**

Create `packages/client/src/router/index.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { router } from './index';

describe('router', () => {
  it('redirects / to /studio', () => {
    expect(router.resolve('/').path).toBe('/studio');
  });

  it('registers /studio and /account routes', () => {
    const paths = router.getRoutes().map((r) => r.path);
    expect(paths).toContain('/studio');
    expect(paths).toContain('/account');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:client -- router`
Expected: FAIL — cannot resolve module `./index`.

- [ ] **Step 3: Create the minimal `AccountView` placeholder**

Create `packages/client/src/views/AccountView.vue`:
```vue
<template>
  <div class="account-view">
    <h2>Account</h2>
  </div>
</template>

<script setup lang="ts"></script>

<style scoped>
.account-view {
  padding: 30px 20px;
  max-width: 1450px;
  margin: 0 auto;
}
.account-view h2 {
  font-family: monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
</style>
```

- [ ] **Step 4: Create the router**

Create `packages/client/src/router/index.ts`:
```ts
import { createRouter, createWebHistory } from 'vue-router';
import StudioView from '../views/StudioView.vue';
import AccountView from '../views/AccountView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/studio' },
    { path: '/studio', name: 'studio', component: StudioView },
    { path: '/account', name: 'account', component: AccountView },
  ],
});
```

- [ ] **Step 5: Run the router test to verify it passes**

Run: `npm run test:client -- router`
Expected: PASS — both router tests green.

- [ ] **Step 6: Wire the router into `main.ts`**

Replace `packages/client/src/main.ts`:
```ts
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'

createApp(App).use(router).mount('#app')
```

- [ ] **Step 7: Render `<router-view/>` in the shell with temporary nav**

In `packages/client/src/App.vue`, change the `<template>` to render the router outlet plus two temporary nav links (replaced by the Sidebar in Task 6) and import nothing else new:
```vue
<template>
  <ErrorOverlay />
  <nav class="temp-nav">
    <RouterLink to="/studio">Studio</RouterLink>
    <RouterLink to="/account">Account</RouterLink>
  </nav>
  <router-view />
</template>
```
Remove the `import StudioView from './views/StudioView.vue';` line from `App.vue`'s script (StudioView is now reached through the router, not rendered directly). Leave the rest of the script (the `useSynth()` call + the two `provide`s) unchanged.

Add to `App.vue`'s **scoped** styles (create a `<style scoped>` block if none exists, otherwise append):
```css
.temp-nav {
  display: flex;
  gap: 16px;
  padding: 8px 20px;
}
.temp-nav a { color: #00f0ff; text-decoration: none; font-family: monospace; }
.temp-nav a.router-link-active { text-decoration: underline; }
```

- [ ] **Step 8: Verify typecheck + build + navigation**

Run: `npm run typecheck:client && npm run test:client && npm run build:client`
Expected: all pass.

Manual (user): `npm run dev` → `/` redirects to `/studio`; the Studio link shows the synth, the Account link shows the "Account" heading; **start audio on Studio, navigate to Account and back — audio keeps playing and the focused track is preserved** (the key audio-continuity check).

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/router/index.ts packages/client/src/router/index.test.ts packages/client/src/views/AccountView.vue packages/client/src/main.ts packages/client/src/App.vue
git commit -m "feat(client): add vue-router with /studio and /account routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Build the full `AccountView` (username editor + identity + sign out)

This moves the username editing logic out of `RoomBar` into the Account page and adds the identity readout. After this task, username editing has a permanent home, so Task 6 can safely drop `RoomBar` from the studio header.

**Files:**
- Modify: `packages/client/src/views/AccountView.vue`

- [ ] **Step 1: Implement the full Account page**

Replace `packages/client/src/views/AccountView.vue`:
```vue
<template>
  <div class="account-view">
    <h2>Account</h2>

    <div v-if="!auth.isAuthenticated.value" class="signed-out">
      <p>Sign in to manage your account.</p>
      <button class="btn" @click="auth.signInWithGoogle()">Sign in with Google</button>
    </div>

    <template v-else>
      <section class="card">
        <h3>Username</h3>
        <div class="username-row">
          <input
            v-model="draftName"
            class="username-input"
            placeholder="username"
            @keyup.enter="save"
          />
          <button class="btn" :disabled="saving" @click="save">Save</button>
          <span v-if="status" class="status" :class="status">{{ statusText }}</span>
        </div>
      </section>

      <section class="card identity">
        <h3>Identity</h3>
        <div class="identity-row">
          <img v-if="profile.avatarUrl" :src="profile.avatarUrl" class="avatar" alt="" />
          <span class="swatch" :style="{ background: selfColor }" />
          <div class="identity-text">
            <div class="name">{{ profile.name ?? selfHandle ?? '—' }}</div>
            <div class="email">{{ profile.email ?? '' }}</div>
          </div>
        </div>
      </section>

      <button class="btn sign-out" @click="auth.signOut()">Sign out</button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';

const auth = useAuth();
const profile = auth.userProfile;

const draftName = ref('');
const saving = ref(false);
const status = ref<'' | 'ok' | 'taken'>('');
const statusText = ref('');

// Self entry in the roster (server-resolved handle + assigned color).
const selfEntry = computed(() =>
  roster.value.find((r) => r.clientId === selfClientId.value) ?? null,
);
const selfHandle = computed(() => selfEntry.value?.handle ?? '');
const selfColor = computed(() => selfEntry.value?.color ?? '#444');

// Pre-fill the input with the current handle without clobbering active typing
// (only seed when empty or still equal to the prior handle).
watch(
  selfHandle,
  (next, prev) => {
    if (!next) return;
    if (draftName.value === '' || draftName.value === prev) draftName.value = next;
  },
  { immediate: true },
);

async function save() {
  if (!draftName.value.trim()) return;
  saving.value = true;
  status.value = '';
  try {
    const res = await auth.setUsername(draftName.value.trim());
    if (res.ok) {
      status.value = 'ok';
      statusText.value = 'saved';
    } else {
      status.value = 'taken';
      statusText.value = res.reason === 'taken' ? 'taken' : 'sign in first';
    }
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.account-view {
  padding: 30px 20px;
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.account-view h2 {
  font-family: monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
}
.signed-out { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.card {
  background: #1a1a1a;
  border: 1px solid #222;
  border-radius: 8px;
  padding: 18px;
}
.card h3 {
  margin: 0 0 12px;
  color: #888;
  font-family: monospace;
  text-transform: uppercase;
  font-size: 0.85rem;
  letter-spacing: 0.05em;
}
.username-row { display: flex; gap: 8px; align-items: center; }
.username-input {
  font-size: 0.9rem;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #111;
  color: #eee;
  width: 200px;
}
.btn {
  font-size: 0.85rem;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.sign-out { align-self: flex-start; }
.status { font-size: 0.8rem; }
.status.ok { color: #2ECC40; }
.status.taken { color: #FF4136; }
.identity-row { display: flex; align-items: center; gap: 12px; }
.avatar { width: 40px; height: 40px; border-radius: 50%; }
.swatch { width: 16px; height: 16px; border-radius: 4px; display: inline-block; }
.identity-text .name { font-weight: 600; }
.identity-text .email { font-size: 0.8rem; color: #888; }
</style>
```

- [ ] **Step 2: Verify typecheck + build**

Run: `npm run typecheck:client && npm run build:client`
Expected: both succeed.

Manual (user): on `/account` while signed in — username prefills with current handle, Save persists (chip/handle updates), `taken` shows on a duplicate, avatar/name/email/color render. Signed out — only the prompt + Google button appear.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/views/AccountView.vue
git commit -m "feat(client): full Account page with username editor + identity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Build the `Sidebar` and the shell grid layout

**Files:**
- Create: `packages/client/src/components/Sidebar.vue`
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/views/StudioView.vue`

- [ ] **Step 1: Create the `Sidebar` component**

Create `packages/client/src/components/Sidebar.vue`:
```vue
<template>
  <aside class="sidebar">
    <div class="brand">
      <h1>Fiddle Synth</h1>
      <span class="sub-brand">// 4-TRACK SEQUENCER</span>
    </div>

    <nav class="nav">
      <RouterLink to="/studio" class="nav-link">Studio</RouterLink>
      <RouterLink to="/account" class="nav-link">Account</RouterLink>
    </nav>

    <div class="identity">
      <button
        v-if="!auth.isAuthenticated.value"
        class="signin-btn"
        @click="auth.signInWithGoogle()"
      >
        Sign in with Google
      </button>
      <RouterLink v-else to="/account" class="self-card">
        <span class="swatch" :style="{ background: selfColor }" />
        <span class="self-handle">{{ selfHandle || 'you' }}</span>
      </RouterLink>
    </div>

    <div class="roster" v-if="others.length">
      <div class="roster-label">In the room</div>
      <div
        v-for="r in others"
        :key="r.clientId"
        class="chip"
        :style="{ background: r.color }"
        :title="r.handle"
      >
        {{ r.handle }}
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';

const auth = useAuth();

const selfEntry = computed(() =>
  roster.value.find((r) => r.clientId === selfClientId.value) ?? null,
);
const selfHandle = computed(() => selfEntry.value?.handle ?? '');
const selfColor = computed(() => selfEntry.value?.color ?? '#444');
const others = computed(() =>
  roster.value.filter((r) => r.clientId !== selfClientId.value),
);
</script>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px 16px;
  height: 100vh;
  box-sizing: border-box;
  background: #161616;
  border-right: 1px solid #222;
  overflow-y: auto;
}
.brand { display: flex; flex-direction: column; }
.sub-brand {
  font-family: monospace;
  font-size: 0.7rem;
  color: #666;
  font-weight: bold;
  letter-spacing: 0.1em;
  margin-top: 2px;
}
.nav { display: flex; flex-direction: column; gap: 4px; }
.nav-link {
  color: #aaa;
  text-decoration: none;
  font-family: monospace;
  text-transform: uppercase;
  font-size: 0.8rem;
  letter-spacing: 0.05em;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
}
.nav-link:hover { color: #fff; background: #1f1f1f; }
.nav-link.router-link-active {
  color: #00f0ff;
  border-color: #2a2a2a;
  background: #1a1a1a;
}
.identity { margin-top: auto; }
.signin-btn {
  width: 100%;
  font-size: 0.8rem;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
}
.self-card {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: #eee;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #2a2a2a;
  background: #1a1a1a;
}
.swatch { width: 14px; height: 14px; border-radius: 4px; flex-shrink: 0; }
.self-handle { font-size: 0.85rem; font-weight: 600; }
.roster { display: flex; flex-direction: column; gap: 6px; }
.roster-label {
  font-family: monospace;
  font-size: 0.7rem;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.chip {
  padding: 2px 10px;
  border-radius: 12px;
  color: #111;
  font-size: 12px;
  font-weight: 600;
  align-self: flex-start;
}
</style>
```

Note: `.identity { margin-top: auto; }` pushes the identity + roster to the bottom of the rail, below the brand and nav.

- [ ] **Step 2: Use the Sidebar + grid layout in the shell**

In `packages/client/src/App.vue`, replace the `<template>` (removing the temporary nav from Task 4) and add the import:
```vue
<template>
  <ErrorOverlay />
  <div class="app-shell">
    <Sidebar />
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>
```
Add to the `<script setup>` imports:
```ts
import Sidebar from './components/Sidebar.vue';
```
Replace the `App.vue` **scoped** style block (the `.temp-nav` rules from Task 4) with the shell grid:
```css
.app-shell {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}
.app-main {
  min-width: 0;
  overflow-x: hidden;
}
```

- [ ] **Step 3: Remove the brand + RoomBar from the studio header**

The brand and presence now live in the sidebar, so trim them from `StudioView.vue`. In `packages/client/src/views/StudioView.vue`:

Replace the `<header>` block (currently containing `.brand`, `<RoomBar />`, and `.transport`) so it keeps only the transport:
```vue
    <header>
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
    </header>
```
Remove the now-unused `import RoomBar from '../components/RoomBar.vue';` line from StudioView's script.

In StudioView's scoped styles, the `header` rule uses `justify-content: space-between` (it previously separated brand from transport). With only the transport left, change it to right-align:
```css
header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-bottom: 30px;
  flex-shrink: 0;
  border-bottom: 1px solid #222;
  padding-bottom: 20px;
}
```
Leave the `.brand` / `.sub-brand` scoped rules in StudioView unused-but-harmless, or delete them (they no longer match any element). Delete them to keep the file clean.

- [ ] **Step 4: Verify typecheck + build + browser**

Run: `npm run typecheck:client && npm run test:client && npm run build:client`
Expected: all pass.

Manual (user): sidebar shows brand, Studio/Account nav (active highlight), your identity card (or Sign in), and other users as chips; the studio header now shows only the transport; navigating Studio⇄Account keeps audio alive.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Sidebar.vue packages/client/src/App.vue packages/client/src/views/StudioView.vue
git commit -m "feat(client): sidebar nav + identity/presence, shell grid layout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Delete the retired `RoomBar` and run the full gate

**Files:**
- Delete: `packages/client/src/components/RoomBar.vue`

- [ ] **Step 1: Confirm `RoomBar` has no remaining importers**

Run: `grep -rn "RoomBar" packages/client/src`
Expected: no matches (Task 3 moved it into StudioView, Task 6 removed it). If any import remains, remove it before deleting.

- [ ] **Step 2: Delete the file**

```bash
git rm packages/client/src/components/RoomBar.vue
```

- [ ] **Step 3: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. Client test count is 235 (baseline 231 + 2 new `useAuth` tests from Task 2 + 2 router tests from Task 4). No regressions.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(client): remove retired RoomBar component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria

- Left sidebar holds brand, Studio/Account nav, your identity (or Sign in), and the roster of other users.
- `/studio` is the synth (transport-only header); `/account` is the username editor + identity readout + sign out, or a sign-in prompt when signed out.
- Navigating between routes never drops audio or the WS connection, and never resets the focused track.
- `RoomBar.vue` is gone; full gate (`typecheck`, `test`, `build`) is green.
