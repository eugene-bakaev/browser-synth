# Channel-Rack UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the studio overview into a DAW-style channel rack — compact, uniform-width track columns in a horizontal scroll, each with an inline mixer footer — and unmount the separate bottom mixer.

**Architecture:** Presentation-layer only. The track pool, `Project` model, sync paths, and audio engine are untouched. Volume/mute/solo move from `TrackMixer.vue` (unmounted but kept) onto each `Tracker.vue` footer, bound to the same reactive `project.tracks[i].mixer` object and sync paths. The overview redesign (narrow columns, fixed row height, scroll) is scoped to non-focused trackers via `:not(.focused)` CSS, so the focused single-track view's layout is unchanged except for gaining the same footer.

**Tech Stack:** Vue 3 (`<script setup>`, SFCs, scoped CSS), TypeScript, Vitest. npm workspaces (`@fiddle/client`). No new dependencies.

**Why so few unit tests:** the client has no Vue component-mount harness (`@vue/test-utils` is not a dependency; every existing client test is logic-only). Introducing one is out of scope. The single piece of real logic here — the engine-label string — is extracted into a pure helper with a unit test (Task 1, TDD). The rest is CSS/markup, verified by the typecheck/build gate (Task 8) and Playwright browser verification, exactly as `AGENTS.md` requires.

**Branch:** Already on `feat/variable-track-count`. Do all work here; do not merge (per `AGENTS.md`).

---

## File Structure

- `packages/client/src/ui/engineLabel.ts` — **new.** Pure helper: engine type (+ synth mode) → display label. Sits beside `trackColors.ts`.
- `packages/client/src/ui/engineLabel.test.ts` — **new.** Unit test for the helper.
- `packages/client/src/components/Tracker.vue` — **modified.** Fixed two-row header, compact non-focused sizing + fixed row height, inline mixer footer (knob + MUTE/SOLO). New `mixer` prop.
- `packages/client/src/views/StudioView.vue` — **modified.** Pass `mixer` to both `Tracker` usages; drop the engine suffix from the overview title; horizontal-scroll rack; ghost "+" column; remove the bottom `TrackMixer` section + its import.
- `packages/client/src/components/TrackMixer.vue` — **modified.** Add an intentionally-retained comment; no longer mounted.
- `packages/client/src/components/Knob.vue` — reused unchanged.

---

## Task 1: `engineLabel` pure helper (TDD)

**Files:**
- Create: `packages/client/src/ui/engineLabel.ts`
- Test: `packages/client/src/ui/engineLabel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/ui/engineLabel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { engineLabel } from './engineLabel';

describe('engineLabel', () => {
  it('labels a mono synth', () => {
    expect(engineLabel('synth', 'mono')).toBe('SYNTH · MONO');
  });

  it('labels a poly synth', () => {
    expect(engineLabel('synth', 'poly')).toBe('SYNTH · POLY');
  });

  it('treats a synth with no mode as mono', () => {
    expect(engineLabel('synth')).toBe('SYNTH · MONO');
  });

  it('uppercases the drum engines (no sub-mode)', () => {
    expect(engineLabel('kick')).toBe('KICK');
    expect(engineLabel('hat')).toBe('HAT');
    expect(engineLabel('snare')).toBe('SNARE');
    expect(engineLabel('clap')).toBe('CLAP');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -w @fiddle/client -- engineLabel`
Expected: FAIL — `Failed to resolve import './engineLabel'` / `engineLabel is not a function`.

- [ ] **Step 3: Implement the helper**

Create `packages/client/src/ui/engineLabel.ts`:

```ts
// Human-readable label for the Tracker's fixed second header row. Synth
// distinguishes mono/poly; the drum engines (kick/hat/snare/clap) have no
// sub-mode, so the engine name alone is the label.
export function engineLabel(engineType: string, mode?: 'mono' | 'poly'): string {
  if (engineType === 'synth') {
    return mode === 'poly' ? 'SYNTH · POLY' : 'SYNTH · MONO';
  }
  return engineType.toUpperCase();
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -w @fiddle/client -- engineLabel`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/ui/engineLabel.ts packages/client/src/ui/engineLabel.test.ts
git commit -m "feat(client): engineLabel helper for the tracker header

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Compact non-focused Tracker columns + fixed row height (CSS)

Scope every change to `.tracker-container:not(.focused)` so the focused single-track view is untouched. Vue scoped CSS reaches the root `<input>` of the `StepNumberInput` child (OCT/LEN), so no `:deep()` is needed.

**Files:**
- Modify: `packages/client/src/components/Tracker.vue` (CSS only)

- [ ] **Step 1: Add the compact overrides to the `<style scoped>` block**

Append these rules to the end of the `<style scoped>` block in `packages/client/src/components/Tracker.vue` (after the existing rules). They have higher specificity than the base rules and therefore win for non-focused trackers:

```css
/* === Channel-rack: compact sizing for the overview (non-focused) only === */
/* Focused single-track view keeps the original 275px layout untouched. */
.tracker-container:not(.focused) {
  width: 180px;
  padding: 7px;
}

/* Narrowed step-grid columns. One flexible column per track type fills the
   uniform 180px width so there is no dead space: NOTE (mono), CHORD (poly),
   VEL (drums). */
.tracker-container:not(.focused) .tracker-row.synth-row {
  grid-template-columns: 18px 20px minmax(34px, 1fr) 28px 32px;
  gap: 2px;
}
.tracker-container:not(.focused) .tracker-row.chord-row {
  grid-template-columns: 18px 18px 30px minmax(40px, 1fr) 24px 26px;
  gap: 2px;
}
.tracker-container:not(.focused) .tracker-row.drum-row {
  grid-template-columns: 18px 20px 26px minmax(0, 1fr);
  gap: 2px;
}

/* Fixed, identical row height across synth/poly/drum so the playhead row
   highlight lines up horizontally across adjacent columns in the rack. */
.tracker-container:not(.focused) .step-row {
  height: 23px;
  padding: 0 2px;
}

/* Shrink the inputs to fit 1-2 characters. Reaches the StepNumberInput root
   input via Vue's child-root scoping. */
.tracker-container:not(.focused) select,
.tracker-container:not(.focused) input[type="number"] {
  height: 18px;
  font-size: 0.66rem;
}
.tracker-container:not(.focused) .trig-btn {
  height: 16px;
  width: 16px;
}
.tracker-container:not(.focused) .mute-btn {
  height: 18px;
}
```

- [ ] **Step 2: Verify it typechecks/builds**

Run: `npm run typecheck`
Expected: exit 0 (CSS changes don't affect types; this confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/Tracker.vue
git commit -m "feat(client): compact non-focused tracker columns for the rack

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Fixed-height two-row Tracker header

Replace the single-row title bar with a fixed-height two-row header: row 1 = `TRK N` + EDIT/DEL, row 2 = always-present engine label (via `engineLabel` from Task 1).

**Files:**
- Modify: `packages/client/src/components/Tracker.vue` (template + script + CSS)

- [ ] **Step 1: Replace the title-bar template block**

In `packages/client/src/components/Tracker.vue`, replace this existing block (the `.tracker-title-bar` div, currently lines 3–14):

```html
    <div class="tracker-title-bar" @click="$emit('select-track')">
      <span class="track-name">{{ title }}</span>
      <div class="title-actions" v-if="!isFocused">
        <span class="title-badge focus-hint">EDIT</span>
        <button
          v-if="canRemove"
          class="title-badge remove-badge"
          title="Remove this track"
          @click.stop="$emit('remove')"
        >DEL</button>
      </div>
    </div>
```

with this two-row header:

```html
    <div class="tracker-header-bar">
      <div class="tracker-title-row" @click="$emit('select-track')">
        <span class="track-name">{{ title }}</span>
        <div class="title-actions" v-if="!isFocused">
          <span class="title-badge focus-hint">EDIT</span>
          <button
            v-if="canRemove"
            class="title-badge remove-badge"
            title="Remove this track"
            @click.stop="$emit('remove')"
          >DEL</button>
        </div>
      </div>
      <div class="tracker-engine-row">{{ engineLabelText }}</div>
    </div>
```

- [ ] **Step 2: Add the `engineLabelText` computed and import**

In the `<script setup>` block of `Tracker.vue`, add the import near the other imports (alongside `import StepNumberInput from './StepNumberInput.vue';`):

```ts
import { engineLabel } from '../ui/engineLabel';
```

Then add this computed after the existing `visibleSteps` computed (the script already imports `computed` from `vue`):

```ts
// Always-present engine label for the fixed second header row.
const engineLabelText = computed(() => engineLabel(props.engineType, props.mode));
```

- [ ] **Step 3: Replace the title-bar CSS**

In the `<style scoped>` block, replace the existing `.tracker-title-bar`, `.tracker-title-bar:hover`, and the focus-hint hover rule. Find these existing rules:

```css
.tracker-title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #181818;
  border-bottom: 2px solid var(--track-color);
  padding: 6px 8px;
  margin-bottom: 8px;
  cursor: pointer;
  border-radius: 4px 4px 0 0;
  user-select: none;
  transition: background-color 0.2s;
}

.tracker-title-bar:hover {
  background: #222;
}
```

Replace them with:

```css
.tracker-header-bar {
  background: #181818;
  border-bottom: 2px solid var(--track-color);
  border-radius: 4px 4px 0 0;
  margin-bottom: 8px;
}

.tracker-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s;
}

.tracker-title-row:hover {
  background: #222;
}

.tracker-engine-row {
  height: 16px;
  padding: 0 8px 4px;
  font-size: 0.6rem;
  color: #7a7a7a;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
```

Then find this existing focus-hint hover rule (which still references the old class name):

```css
.tracker-title-bar:hover:not(:has(.remove-badge:hover)) .focus-hint {
  color: var(--track-color);
  border-color: var(--track-color);
}
```

and change its selector to the new row class:

```css
.tracker-title-row:hover:not(:has(.remove-badge:hover)) .focus-hint {
  color: var(--track-color);
  border-color: var(--track-color);
}
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: exit 0. (`props.engineType` is `string`, `props.mode` is `'mono' | 'poly'` — both match `engineLabel`'s signature.)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Tracker.vue
git commit -m "feat(client): fixed two-row tracker header with engine label

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Inline mixer footer on the Tracker (knob + MUTE/SOLO)

Add a footer under the step grid: the existing `Knob` (LEVEL, dB) + stacked MUTE/SOLO, bound to a new `mixer` prop using the same sync paths `TrackMixer` used. Because `Tracker` renders this footer unconditionally, it appears in both the overview and the focused view (satisfying the focused-view requirement with no special case).

**Files:**
- Modify: `packages/client/src/components/Tracker.vue` (template + script + CSS)

- [ ] **Step 1: Add the footer markup**

In `packages/client/src/components/Tracker.vue`, add this block immediately after the closing `</div>` of `.tracker-steps` and before the final closing `</div>` of `.tracker-container`:

```html
    <!-- Inline mixer footer — replaces the old bottom Track Mixer strip. Binds
         the same reactive mixer object + sync paths the TrackMixer used. -->
    <div class="tracker-mixer">
      <Knob
        label="LEVEL"
        :min="0"
        :max="1"
        :step="0.01"
        :defaultValue="DEFAULT_MIXER_STATE.volume"
        format="db"
        v-model="mixer.volume"
        :syncPath="['tracks', trackId, 'mixer', 'volume']"
        @gesture-end="endGesture(['tracks', trackId, 'mixer', 'volume'])"
      />
      <div class="tracker-mixer-buttons">
        <button
          class="mix-btn mute"
          :class="{ active: mixer.muted }"
          @click="mixer.muted = !mixer.muted"
          title="Mute"
        >MUTE</button>
        <button
          class="mix-btn solo"
          :class="{ active: mixer.soloed }"
          @click="mixer.soloed = !mixer.soloed"
          title="Solo"
        >SOLO</button>
      </div>
    </div>
```

- [ ] **Step 2: Add the `mixer` prop, imports, and use `MixerState`**

In the `<script setup>` block of `Tracker.vue`, add these imports near the existing component/util imports:

```ts
import Knob from './Knob.vue';
import { DEFAULT_MIXER_STATE } from '../project';
import type { MixerState } from '../project';
import { endGesture } from '../composables/useSynth';
```

Then add `mixer` to the `defineProps` object. The current definition is:

```ts
const props = withDefaults(defineProps<{
  steps: Step[];
  currentStep: number;
  title: string;
  color?: string;
  isFocused?: boolean;
  trackId: number;
  engineType: string;
  mode?: 'mono' | 'poly';
  patternLength: number;
  canRemove?: boolean;
}>(), {
  mode: 'mono'
});
```

Add the `mixer` field so it becomes:

```ts
const props = withDefaults(defineProps<{
  steps: Step[];
  currentStep: number;
  title: string;
  color?: string;
  isFocused?: boolean;
  trackId: number;
  engineType: string;
  mode?: 'mono' | 'poly';
  patternLength: number;
  canRemove?: boolean;
  mixer: MixerState;
}>(), {
  mode: 'mono'
});
```

- [ ] **Step 3: Add the footer CSS**

Append to the `<style scoped>` block in `Tracker.vue`:

```css
/* === Inline mixer footer === */
.tracker-mixer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #222;
}

.tracker-mixer-buttons {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.mix-btn {
  height: 20px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 0.62rem;
  font-weight: bold;
  background: rgba(0, 0, 0, 0.4);
  color: #666;
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: background-color 0.2s, color 0.2s, border-color 0.2s;
}

.mix-btn:hover {
  color: #aaa;
  border-color: rgba(255, 255, 255, 0.15);
}

.mix-btn.mute.active {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 0 10px rgba(239, 68, 68, 0.25);
}

.mix-btn.solo.active {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.4);
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.25);
}
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: FAIL — `vue-tsc` reports that both `<Tracker>` usages in `StudioView.vue` are missing the required `mixer` prop. This is expected; Task 5 supplies it. (If you prefer a clean intermediate gate, do Step 5 of this task and Task 5 back-to-back before running the full gate.)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Tracker.vue
git commit -m "feat(client): inline mixer footer (knob + mute/solo) on the tracker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire `mixer` into both Tracker usages in StudioView

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (overview + focused `Tracker` props)

- [ ] **Step 1: Overview Tracker — add `:mixer` and drop the engine suffix from the title**

In `packages/client/src/views/StudioView.vue`, the overview `Tracker` currently has:

```html
            :steps="entry.track.steps"
            :currentStep="currentStep"
            :title="`Track ${entry.index + 1} [${getTrackEngineType(entry.index).toUpperCase()}]`"
            :color="trackColor(entry.index)"
```

Change the `:title` (the engine now lives on the header's second row) and add `:mixer`:

```html
            :steps="entry.track.steps"
            :currentStep="currentStep"
            :title="`Track ${entry.index + 1}`"
            :mixer="project.tracks[entry.index].mixer"
            :color="trackColor(entry.index)"
```

- [ ] **Step 2: Focused Tracker — add `:mixer`**

The focused `Tracker` currently has:

```html
            <Tracker
              :steps="project.tracks[activeTrackIndex].steps"
              :currentStep="currentStep"
              :title="`Track ${activeTrackIndex + 1}`"
              :color="trackColor(activeTrackIndex)"
```

Add `:mixer` so the focused track gets its footer too:

```html
            <Tracker
              :steps="project.tracks[activeTrackIndex].steps"
              :currentStep="currentStep"
              :title="`Track ${activeTrackIndex + 1}`"
              :mixer="focusedTrack!.mixer"
              :color="trackColor(activeTrackIndex)"
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: exit 0. Both `Tracker` usages now pass the required `mixer` prop; `project.tracks[i].mixer` and `focusedTrack!.mixer` are `MixerState`.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(client): pass mixer state to overview + focused trackers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Horizontal-scroll rack + ghost "+" column; remove bottom mixer

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (template + CSS + import)

- [ ] **Step 1: Replace the add-track button with a ghost column**

In `StudioView.vue`, the overview grid currently ends with:

```html
        <button
          v-if="enabledTrackCount < TRACK_POOL_SIZE"
          class="add-track-btn"
          @click="addTrack"
        >+ ADD TRACK</button>
```

Replace it with a ghost column (same width as a track, just a `+`):

```html
        <button
          v-if="enabledTrackCount < TRACK_POOL_SIZE"
          class="add-track-ghost"
          @click="addTrack"
          title="Add a track"
        >+</button>
```

- [ ] **Step 2: Remove the bottom mixer section from the template**

Delete this entire block from the template:

```html
    <!-- Track Mixer (Globally visible at the bottom) -->
    <div class="mixer-section">
      <TrackMixer
        :trackStates="project.tracks"
        :sequencer="sequencer"
        :currentStep="currentStep"
      />
    </div>
```

- [ ] **Step 3: Remove the TrackMixer import**

In the `<script setup>` block, delete this line:

```ts
import TrackMixer from '../components/TrackMixer.vue';
```

(Leave all other imports and the `synth` destructure as-is — `sequencer`, `currentStep`, `addTrack`, `enabledTrackCount`, `removeTrack`, `trackColor`, and `TRACK_POOL_SIZE` are all still used elsewhere.)

- [ ] **Step 4: Update the grid CSS for horizontal scroll, and swap the add-track styles**

Find the existing `.tracks-grid` rule:

```css
.tracks-grid {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 20px;
  justify-content: center;
  width: 100%;
}
```

Replace it with a non-wrapping, horizontally scrolling row:

```css
.tracks-grid {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  gap: 16px;
  align-items: flex-start;
  width: 100%;
  overflow-x: auto;
  padding-bottom: 12px;
}
```

Then find and delete the old add-track button rules:

```css
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

and replace them with the ghost-column rules:

```css
.add-track-ghost {
  flex: 0 0 auto;
  align-self: stretch;
  width: 180px;
  min-height: 140px;
  border: 1px dashed #333;
  border-radius: 6px;
  background: #0f0f0f;
  color: #555;
  font-family: monospace;
  font-size: 2rem;
  font-weight: bold;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
}
.add-track-ghost:hover {
  color: #00f0ff;
  border-color: #00f0ff;
  background: #141414;
}
```

Finally, delete the now-unused `.mixer-section` rule:

```css
.mixer-section {
  margin-top: 30px;
  flex-shrink: 0;
}
```

- [ ] **Step 5: Verify it typechecks**

Run: `npm run typecheck`
Expected: exit 0 — `TrackMixer` is no longer referenced, and no other binding broke.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(client): horizontal channel rack + ghost add column; unmount bottom mixer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Mark TrackMixer.vue as intentionally retained

**Files:**
- Modify: `packages/client/src/components/TrackMixer.vue` (top-of-file comment only)

- [ ] **Step 1: Add the retention comment**

At the very top of `packages/client/src/components/TrackMixer.vue`, above the `<template>` tag, add:

```html
<!--
  INTENTIONALLY RETAINED — not currently mounted anywhere.

  The per-track inline mixer footer in Tracker.vue replaced this bottom mixer
  strip in the channel-rack redesign (2026-06-05, see
  docs/superpowers/specs/2026-06-05-channel-rack-ui-design.md). This component
  is kept on purpose for a future consolidated "master mixer" view. Do NOT
  delete it as dead code.
-->
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/TrackMixer.vue
git commit -m "docs(client): mark TrackMixer as intentionally retained (unmounted)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Full gate + Playwright verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0. The `engineLabel` suite passes; the existing mixer-gating audio logic and all other suites still pass (their behavior is unchanged — only where the controls render moved).

- [ ] **Step 2: Start the dev server**

Run: `npm run dev`
Expected: Vite serves the client (default `http://localhost:5173`).

- [ ] **Step 3: Verify in the browser via Playwright MCP**

Drive the running app and confirm, watching the console for errors throughout:

1. **Rack layout** — the overview shows enabled tracks as a single horizontal, non-wrapping row that scrolls sideways; columns are uniform width (~180px); no console errors.
2. **Header** — each column shows the fixed two-row header: `Track N` + EDIT/DEL on row 1, engine label (`SYNTH · MONO`, `KICK`, …) on row 2. Removing a track still prompts for confirm and works.
3. **Inline mixer** — turning a column's LEVEL knob changes that track's volume; MUTE silences it; SOLO isolates it (other tracks audibly drop). Behavior matches the old bottom mixer. Add a few tracks first so solo/mute are observable.
4. **Track types** — a poly synth track shows `ROOT · CHORD · OCT · LEN` with chord names (e.g. `maj7`, `sus4`) not truncated; a drum track shows TRIG + velocity; a mono synth shows NOTE/OCT/LEN. Row heights line up across adjacent columns.
5. **Ghost column** — the dashed "+" column sits at the end and adds a track; it disappears once 32 tracks are enabled.
6. **Focused view** — clicking a track opens the focused editor, which shows the same knob + MUTE/SOLO footer; they work there. The focused sequencer/engine layout is otherwise unchanged.
7. **Bottom mixer gone** — there is no separate Track Mixer section at the bottom of the studio.

- [ ] **Step 4: Close the browser**

Per `AGENTS.md`, always close the Playwright browser/session when finished — do not leave tabs open.

- [ ] **Step 5: Report**

Report exactly what was observed (including any console output). Do not claim done without this evidence. Leave the branch as-is for the user's own visual/audio sign-off; do not merge.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-05-channel-rack-ui-design.md`):
- §1 horizontal rack → Task 6 Step 4. ✓
- §2 compact uniform columns + flexible column per type → Task 2. ✓
- §3 fixed two-row header → Task 3. ✓
- §4 inline mixer footer (knob + M/S, same sync paths) → Task 4 + Task 5. ✓
- §5 unmount bottom mixer, keep file marked → Task 6 (Steps 2–3) + Task 7. ✓
- §6 ghost "+" column, hidden when pool full → Task 6 Step 1 + the `v-if`. ✓
- §7 focused view same footer → Task 4 (footer is unconditional) + Task 5 Step 2. ✓
- §8 fixed row height, drum velocity preserved → Task 2 (`.step-row` height; drum-row keeps its VEL column). ✓

**Type consistency:** `engineLabel(engineType: string, mode?: 'mono' | 'poly')` is defined in Task 1 and called the same way in Task 3. The `mixer: MixerState` prop is added in Task 4 and supplied with `MixerState`-typed values in Task 5. Sync path arrays `['tracks', trackId, 'mixer', 'volume']` match the shape `TrackMixer` used. No dangling references.

**Placeholder scan:** every code step shows complete code; no TBD/TODO/"handle edge cases". The intermediate typecheck failure at Task 4 Step 4 is called out as expected (resolved by Task 5), not a placeholder.
