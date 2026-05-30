# Slice-down Panel Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind engine/drum panels directly to the reactive `project` engine slice, deleting the ~30 `trackParam` writable-computeds in `useSynth.ts` and both `v-model` walls (App→SynthPanel, SynthPanel→leaf panels).

**Architecture:** Each panel receives one `:params` prop — the live reactive `project.tracks[i].engines.<engine>` object — and binds its `<Knob>`s with `v-model="params.<field>"`. Because Vue passes reactive objects by reference, writes land on `project`, the **existing `useSynth` watchers (unchanged)** fire, and engine + outbox react. The `knobSync` sync-path layer is untouched. This is **behavior-preserving**; the spec is at `docs/superpowers/specs/2026-05-30-slice-down-binding-design.md`.

**Tech Stack:** Vue 3 `<script setup>` + TypeScript, Vite, Vitest, `vue-tsc`. Monorepo workspace `@fiddle/client`.

---

## How this plan is verified (read first)

This is a **refactor with no new runtime behavior**, so there is no new red-green test to write. The safety net is:

1. **`vue-tsc` typecheck** — catches wrong field names, wrong slice types, missing props. A typo like `params.filterCutofff` fails here.
2. **The existing Vitest suite** — `useSynth.test.ts` exercises the watcher layer by mutating `project` directly (e.g. `synth.project.tracks[0].engines.synth.filterCutoff = 1234`). It does **not** reference the `trackParam` refs, so it stays green and unchanged throughout.
3. **A final manual/Playwright check** (Task 8) — the one regression the type system can NOT catch is a *mis-wired but still-typed* binding (e.g. `v-model="params.osc1Level"` placed on the OSC 2 knob). The fix: when editing each panel, keep the `v-model` field name identical to the adjacent `ks.pathFor('<field>')` argument. The manual check confirms a knob turn still changes audio AND broadcasts.

**Per-task verification command** (fast, client-scoped):
```bash
npm run typecheck:client && npm run test:client
```
Expected: `vue-tsc` exits 0, Vitest reports all client tests passing (215 at start).

**Note on lint:** the repo has **no ESLint config** and Vue does **not** warn on *nested* prop mutation (only on reassigning a prop binding itself). So the spec's flagged `vue/no-mutating-props` risk is **not applicable** — do not add a lint step or hunt for a config.

**Type used throughout:** the engine slice type is `EngineParamsMap['synth' | 'kick' | 'hat' | 'snare' | 'clap']`, already exported from `../project` (re-exported from `@fiddle/shared`). Import it in each panel with `import type { EngineParamsMap } from '../project';`.

---

## File map

- `packages/client/src/composables/useSynth.ts` — add `focusedTrack`; delete `trackParam` + ~30 param refs + `engineType`/`synthMode` computeds + their `return` entries + now-unused imports.
- `packages/client/src/App.vue` — shrink `useSynth()` destructure; replace `v-model:` walls with one `:params` per panel; route engine-type through `focusedTrack`.
- `packages/client/src/components/KickPanel.vue`, `HatPanel.vue`, `SnarePanel.vue`, `ClapPanel.vue` — `defineModel` → `params` prop.
- `packages/client/src/components/SynthPanel.vue` — `defineModel` ×13 → one `params` prop, passed to the four sub-panels.
- `packages/client/src/components/OscillatorPanel.vue`, `MixerPanel.vue`, `FilterPanel.vue`, `EnvelopePanel.vue` — `defineModel` → `params` prop.
- `docs/ARCHITECTURE.md` — note the binding change (Task 8).

**Ordering rationale:** the four drum verticals are independent (App→Panel, no intermediate), so each converts in isolation and compiles. The synth vertical (App→SynthPanel→4 children) converts as one task. `focusedTrack` lands first (Task 1) because every panel binding needs it. `trackParam` is deleted in Task 6 (its last callers — the synth refs — go there). `engineType` is replaced last (Task 7) since it is independent of the param refs.

---

### Task 1: Add `focusedTrack` to `useSynth`

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Add the `focusedTrack` computed**

In `useSynth()`, immediately after the `bpm` computed (around line 498), add:

```ts
  // The currently-focused track, or null on the 4-track overview. Panels read
  // their reactive engine slice from this (e.g. focusedTrack.value.engines.synth);
  // mutating that slice writes straight through to `project`, driving the
  // existing slice watchers (audio + outbox). Replaces the per-param trackParam
  // refs that previously projected each field individually.
  const focusedTrack = computed(() =>
    activeTrackIndex.value !== null ? project.tracks[activeTrackIndex.value] : null
  );
```

- [ ] **Step 2: Return it**

In the `return { … }` object, add `focusedTrack,` next to `activeTrackIndex,`:

```ts
    activeTrackIndex,
    focusedTrack,
    currentStep,
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck:client && npm run test:client`
Expected: `vue-tsc` exits 0; all client tests pass. (Additive change — nothing consumes `focusedTrack` yet; that's expected.)

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/composables/useSynth.ts
git commit -m "refactor(useSynth): add focusedTrack computed for slice-down binding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Convert the Kick vertical

**Files:**
- Modify: `packages/client/src/components/KickPanel.vue`
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Rewrite `KickPanel.vue` `<script setup>`**

Replace the entire `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { KickEngine } from '../engine/KickEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = KickEngine.DEFAULT_PARAMS;
const ks = useKnobSync('kick');

defineProps<{
  params: EngineParamsMap['kick'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>
```

- [ ] **Step 2: Update the `KickPanel.vue` knob bindings**

In the template, change the three `v-model` references to read from `params`:

- `v-model="tune"` → `v-model="params.tune"`
- `v-model="decay"` → `v-model="params.decay"`
- `v-model="click"` → `v-model="params.click"`

(Leave `:syncPath`, `@gesture-end`, `:min/:max/:step/:defaultValue/format`, and the `:analyser`/`:color` on `<Visualizer>` exactly as they are.)

- [ ] **Step 3: Update the `<KickPanel>` usage in `App.vue`**

Add `focusedTrack` to the `useSynth()` destructure in `App.vue` (next to `activeTrackIndex,`):

```ts
  activeTrackIndex,
  focusedTrack,
  currentStep,
```

Then replace the `<KickPanel>` block (currently using `v-model:tune/decay/click`) with:

```vue
            <template v-else-if="engineType === 'kick'">
              <KickPanel
                :params="focusedTrack!.engines.kick"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>
```

(`focusedTrack!` is safe: this block renders only inside the `v-else` focused branch where `activeTrackIndex !== null`.)

- [ ] **Step 4: Delete the Kick refs from `useSynth.ts`**

Delete these three declarations (the `--- Kick params ---` block):

```ts
  const kickTune = trackParam('kick', 'tune', 55);
  const kickDecay = trackParam('kick', 'decay', 0.3);
  const kickClick = trackParam('kick', 'click', 0.5);
```

And delete `kickTune,`, `kickDecay,`, `kickClick,` from the `return { … }` object.

- [ ] **Step 5: Verify typecheck + tests**

Run: `npm run typecheck:client && npm run test:client`
Expected: `vue-tsc` exits 0; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/KickPanel.vue packages/client/src/App.vue packages/client/src/composables/useSynth.ts
git commit -m "refactor(panels): bind KickPanel to reactive engine slice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Convert the Hat vertical

**Files:**
- Modify: `packages/client/src/components/HatPanel.vue`
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Rewrite `HatPanel.vue` `<script setup>`**

Replace the entire `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { HatEngine } from '../engine/HatEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = HatEngine.DEFAULT_PARAMS;
const ks = useKnobSync('hat');

defineProps<{
  params: EngineParamsMap['hat'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>
```

- [ ] **Step 2: Update the `HatPanel.vue` knob bindings**

- `v-model="decay"` → `v-model="params.decay"`
- `v-model="tone"` → `v-model="params.tone"`
- `v-model="metallic"` → `v-model="params.metallic"`

- [ ] **Step 3: Update the `<HatPanel>` usage in `App.vue`**

Replace the `<HatPanel>` block with:

```vue
            <template v-else-if="engineType === 'hat'">
              <HatPanel
                :params="focusedTrack!.engines.hat"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>
```

- [ ] **Step 4: Delete the Hat refs from `useSynth.ts`**

Delete:

```ts
  const hatDecay = trackParam('hat', 'decay', 0.15);
  const hatTone = trackParam('hat', 'tone', 8000);
  const hatMetallic = trackParam('hat', 'metallic', 0.5);
```

And delete `hatDecay,`, `hatTone,`, `hatMetallic,` from the `return { … }` object.

- [ ] **Step 5: Verify typecheck + tests**

Run: `npm run typecheck:client && npm run test:client`
Expected: `vue-tsc` exits 0; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/HatPanel.vue packages/client/src/App.vue packages/client/src/composables/useSynth.ts
git commit -m "refactor(panels): bind HatPanel to reactive engine slice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Convert the Snare vertical

**Files:**
- Modify: `packages/client/src/components/SnarePanel.vue`
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Rewrite `SnarePanel.vue` `<script setup>`**

Replace the entire `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { SnareEngine } from '../engine/SnareEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SnareEngine.DEFAULT_PARAMS;
const ks = useKnobSync('snare');

defineProps<{
  params: EngineParamsMap['snare'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>
```

- [ ] **Step 2: Update the `SnarePanel.vue` knob bindings**

- `v-model="tune"` → `v-model="params.tune"`
- `v-model="decay"` → `v-model="params.decay"`
- `v-model="snappy"` → `v-model="params.snappy"`

- [ ] **Step 3: Update the `<SnarePanel>` usage in `App.vue`**

Replace the `<SnarePanel>` block with:

```vue
            <template v-else-if="engineType === 'snare'">
              <SnarePanel
                :params="focusedTrack!.engines.snare"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>
```

- [ ] **Step 4: Delete the Snare refs from `useSynth.ts`**

Delete:

```ts
  const snareTune = trackParam('snare', 'tune', 180);
  const snareDecay = trackParam('snare', 'decay', 0.25);
  const snareSnappy = trackParam('snare', 'snappy', 0.5);
```

And delete `snareTune,`, `snareDecay,`, `snareSnappy,` from the `return { … }` object.

- [ ] **Step 5: Verify typecheck + tests**

Run: `npm run typecheck:client && npm run test:client`
Expected: `vue-tsc` exits 0; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/SnarePanel.vue packages/client/src/App.vue packages/client/src/composables/useSynth.ts
git commit -m "refactor(panels): bind SnarePanel to reactive engine slice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Convert the Clap vertical

**Files:**
- Modify: `packages/client/src/components/ClapPanel.vue`
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Rewrite `ClapPanel.vue` `<script setup>`**

Replace the entire `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { ClapEngine } from '../engine/ClapEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = ClapEngine.DEFAULT_PARAMS;
const ks = useKnobSync('clap');

defineProps<{
  params: EngineParamsMap['clap'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>
```

- [ ] **Step 2: Update the `ClapPanel.vue` knob bindings**

- `v-model="decay"` → `v-model="params.decay"`
- `v-model="tone"` → `v-model="params.tone"`
- `v-model="sloppy"` → `v-model="params.sloppy"`

- [ ] **Step 3: Update the `<ClapPanel>` usage in `App.vue`**

Replace the `<ClapPanel>` block with:

```vue
            <template v-else-if="engineType === 'clap'">
              <ClapPanel
                :params="focusedTrack!.engines.clap"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>
```

- [ ] **Step 4: Delete the Clap refs from `useSynth.ts`**

Delete:

```ts
  const clapDecay = trackParam('clap', 'decay', 0.25);
  const clapTone = trackParam('clap', 'tone', 1000);
  const clapSloppy = trackParam('clap', 'sloppy', 0.015);
```

And delete `clapDecay,`, `clapTone,`, `clapSloppy,` from the `return { … }` object.

- [ ] **Step 5: Verify typecheck + tests**

Run: `npm run typecheck:client && npm run test:client`
Expected: `vue-tsc` exits 0; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/ClapPanel.vue packages/client/src/App.vue packages/client/src/composables/useSynth.ts
git commit -m "refactor(panels): bind ClapPanel to reactive engine slice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Convert the Synth vertical

This is the largest task: the four sub-panels, the composite `SynthPanel`, the `App.vue` `<SynthPanel>` binding, and the deletion of all synth refs + `synthMode` + the now-unused `trackParam` helper and its imports. Do all steps before verifying — intermediate states will not typecheck.

**Files:**
- Modify: `packages/client/src/components/OscillatorPanel.vue`
- Modify: `packages/client/src/components/MixerPanel.vue`
- Modify: `packages/client/src/components/FilterPanel.vue`
- Modify: `packages/client/src/components/EnvelopePanel.vue`
- Modify: `packages/client/src/components/SynthPanel.vue`
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Rewrite `OscillatorPanel.vue` `<script setup>`**

Replace the `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

defineProps<{
  params: EngineParamsMap['synth'];
  // OscillatorTypeLiteral is the 4-waveform union shared with the engine
  // (excludes DOM's 'custom', which we never use).
  waveforms: OscillatorTypeLiteral[];
}>();
</script>
```

- [ ] **Step 2: Update `OscillatorPanel.vue` template bindings**

Change every oscillator binding to read from `params`:

- `v-model="osc1Type"` → `v-model="params.osc1Type"` (the `<select>`)
- `v-model="osc1Coarse"` → `v-model="params.osc1Coarse"`
- `v-model="osc1Fine"` → `v-model="params.osc1Fine"`
- `v-if="osc1Type === 'square'"` → `v-if="params.osc1Type === 'square'"` and `v-model="osc1PulseWidth"` → `v-model="params.osc1PulseWidth"`
- `v-model="osc2Type"` → `v-model="params.osc2Type"` (the `<select>`)
- `v-model="osc2Coarse"` → `v-model="params.osc2Coarse"`
- `v-model="osc2Fine"` → `v-model="params.osc2Fine"`
- `v-if="osc2Type === 'square'"` → `v-if="params.osc2Type === 'square'"` and `v-model="osc2PulseWidth"` → `v-model="params.osc2PulseWidth"`

(Leave all `:syncPath`/`@gesture-end`/`:defaultValue`/`format` attributes unchanged.)

- [ ] **Step 3: Rewrite `MixerPanel.vue` `<script setup>`**

Replace the `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

defineProps<{
  params: EngineParamsMap['synth'];
}>();
</script>
```

- [ ] **Step 4: Update `MixerPanel.vue` template bindings**

- `v-model="osc1Level"` → `v-model="params.osc1Level"`
- `v-model="osc2Level"` → `v-model="params.osc2Level"`

- [ ] **Step 5: Rewrite `FilterPanel.vue` `<script setup>`**

Replace the `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

defineProps<{
  params: EngineParamsMap['synth'];
}>();
</script>
```

- [ ] **Step 6: Update `FilterPanel.vue` template bindings**

Note the field names now match the sync paths exactly (the old `cutoff`/`res`/`envAmount` local aliases are gone):

- `v-model="cutoff"` → `v-model="params.filterCutoff"`
- `v-model="res"` → `v-model="params.filterRes"`
- `v-model="envAmount"` → `v-model="params.filterEnvAmount"`

(The `:defaultValue="DEFAULTS.filterCutoff"` etc. and `:syncPath="ks.pathFor('filterCutoff')"` are already correct and unchanged.)

- [ ] **Step 7: Rewrite `EnvelopePanel.vue` `<script setup>`**

Replace the `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

const props = withDefaults(
  defineProps<{
    type?: 'filter' | 'amp' | 'both';
    params: EngineParamsMap['synth'];
    // Duration in seconds of the shortest non-muted note on the active track.
    // null when no notes are active (no warning shown).
    shortestActiveNoteDuration?: number | null;
  }>(),
  {
    type: 'both',
    shortestActiveNoteDuration: null,
  }
);

// An envelope is "truncated" when A+D exceeds the note length — the note never
// reaches its sustain level before release kicks in.
const ampEnvExceedsNote = computed(() => {
  if (props.shortestActiveNoteDuration == null) return false;
  return props.params.ampEnv.a + props.params.ampEnv.d > props.shortestActiveNoteDuration;
});

const filterEnvExceedsNote = computed(() => {
  if (props.shortestActiveNoteDuration == null) return false;
  return props.params.filterEnv.a + props.params.filterEnv.d > props.shortestActiveNoteDuration;
});

const formatSeconds = (s: number) => `${Math.round(s * 1000)}ms`;

const warningTitle = (kind: 'filter' | 'amp') => {
  const env = kind === 'amp' ? props.params.ampEnv : props.params.filterEnv;
  if (props.shortestActiveNoteDuration == null) return '';
  const ad = formatSeconds(env.a + env.d);
  const note = formatSeconds(props.shortestActiveNoteDuration);
  return `A+D (${ad}) exceeds shortest active note (${note}). The envelope never reaches sustain — release starts mid-curve.`;
};
</script>
```

- [ ] **Step 8: Update `EnvelopePanel.vue` template bindings**

In the Filter Env block:
- `v-if="(type === 'filter' || type === 'both') && filterEnv"` → `v-if="type === 'filter' || type === 'both'"`
- `v-model="filterEnv.a"` → `v-model="params.filterEnv.a"` (and `.d`, `.s`, `.r` likewise)
- `:defaultValue="DEFAULTS.filterEnv.a"` stays unchanged.

In the Amp Env block:
- `v-if="(type === 'amp' || type === 'both') && ampEnv"` → `v-if="type === 'amp' || type === 'both'"`
- `v-model="ampEnv.a"` → `v-model="params.ampEnv.a"` (and `.d`, `.s`, `.r` likewise)

- [ ] **Step 9: Rewrite `SynthPanel.vue` `<script setup>`**

Replace the `<script setup lang="ts">…</script>` block with:

```vue
<script setup lang="ts">
import OscillatorPanel from './OscillatorPanel.vue';
import MixerPanel from './MixerPanel.vue';
import FilterPanel from './FilterPanel.vue';
import EnvelopePanel from './EnvelopePanel.vue';
import Visualizer from './Visualizer.vue';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import type { EngineParamsMap } from '../project';

defineProps<{
  params: EngineParamsMap['synth'];
  waveforms: OscillatorTypeLiteral[];
  shortestActiveNoteDuration: number | null;
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>
```

- [ ] **Step 10: Update `SynthPanel.vue` template**

Replace the mono/poly toggle bindings and the child-panel bindings. The mono/poly buttons:

- `:class="{ active: mode === 'mono' }"` → `:class="{ active: params.mode === 'mono' }"`, `@click="mode = 'mono'"` → `@click="params.mode = 'mono'"`
- `:class="{ active: mode === 'poly' }"` → `:class="{ active: params.mode === 'poly' }"`, `@click="mode = 'poly'"` → `@click="params.mode = 'poly'"`

Replace the four child-panel elements with:

```vue
      <OscillatorPanel :params="params" :waveforms="waveforms" />
      <MixerPanel :params="params" />
```
```vue
      <FilterPanel :params="params" />
      <EnvelopePanel
        type="filter"
        :params="params"
        :shortestActiveNoteDuration="shortestActiveNoteDuration"
      />
```
```vue
      <EnvelopePanel
        type="amp"
        :params="params"
        :shortestActiveNoteDuration="shortestActiveNoteDuration"
      />
      <Visualizer
        :analyser="analyser"
        :color="color"
      />
```

(Keep the surrounding `.rack-column` wrappers and the `.synth-mode-selector` markup; only the bindings listed above change.)

- [ ] **Step 11: Update the `<SynthPanel>` usage in `App.vue`**

Replace the entire `<SynthPanel … />` element (the 13 `v-model:` lines + `:filterEnv`/`:ampEnv`/etc.) with:

```vue
              <SynthPanel
                :params="focusedTrack!.engines.synth"
                :waveforms="waveforms"
                :shortestActiveNoteDuration="shortestActiveNoteDuration"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
```

- [ ] **Step 12: Update the focused Tracker `:mode` in `App.vue`**

In the focused-view `<Tracker>` (the one with `:isFocused="true"`), change:

- `:mode="synthMode"` → `:mode="focusedTrack!.engines.synth.mode"`

- [ ] **Step 13: Delete synth refs, `synthMode`, `trackParam`, and unused imports from `useSynth.ts`**

Delete the `synthMode` computed block:

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

Delete the entire `--- Synth params ---` block (all 15 `trackParam` declarations from `osc1Type` through `ampEnv`).

Delete the `trackParam` helper function itself:

```ts
  function trackParam<K extends keyof EngineParamsMap, P extends keyof EngineParamsMap[K]>(
    engine: K, param: P, fallback: EngineParamsMap[K][P]
  ): WritableComputedRef<EngineParamsMap[K][P]> {
    return computed({
      get: () => activeTrackIndex.value !== null
        ? project.tracks[activeTrackIndex.value].engines[engine][param]
        : fallback,
      set: (val: EngineParamsMap[K][P]) => {
        if (activeTrackIndex.value !== null) {
          project.tracks[activeTrackIndex.value].engines[engine][param] = val;
        }
      }
    });
  }
```

Delete from the `return { … }` object: `synthMode,`, and all synth param entries (`osc1Type,` `osc2Type,` `osc1Coarse,` `osc1Fine,` `osc2Coarse,` `osc2Fine,` `osc1Level,` `osc2Level,` `osc1PulseWidth,` `osc2PulseWidth,` `filterCutoff,` `filterRes,` `filterEnvAmount,` `filterEnv,` `ampEnv,`).

Remove now-unused imports: in the top `import { … } from 'vue'`, remove `WritableComputedRef`; in the `from '../project'` import, remove `EngineParamsMap` (no longer referenced in this file). Keep `computed` (still used by `focusedTrack`, `bpm`, `shortestActiveNoteDuration`) and keep `ProjectTrack`, `EngineType`.

- [ ] **Step 14: Verify typecheck + tests**

Run: `npm run typecheck:client && npm run test:client`
Expected: `vue-tsc` exits 0 (any leftover reference to a deleted ref or a wrong field name fails here); all client tests pass.

- [ ] **Step 15: Commit**

```bash
git add packages/client/src/components/OscillatorPanel.vue packages/client/src/components/MixerPanel.vue packages/client/src/components/FilterPanel.vue packages/client/src/components/EnvelopePanel.vue packages/client/src/components/SynthPanel.vue packages/client/src/App.vue packages/client/src/composables/useSynth.ts
git commit -m "refactor(panels): bind synth panels to reactive engine slice

Removes the trackParam helper and all synth/synthMode writable-computeds.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Route engine-type through `focusedTrack`; delete the `engineType` computed

**Files:**
- Modify: `packages/client/src/App.vue`
- Modify: `packages/client/src/composables/useSynth.ts`

- [ ] **Step 1: Replace `engineType` usages in `App.vue` with `focusedTrack`**

In the focused-view header h2 (line ~53):
- `({{ engineType.toUpperCase() }})` → `({{ focusedTrack!.engineType.toUpperCase() }})`

In the engine-selector buttons (5 buttons), for each engine `synth`/`kick`/`hat`/`snare`/`clap`:
- `:class="{ active: engineType === 'synth' }"` → `:class="{ active: focusedTrack!.engineType === 'synth' }"`
- `@click="engineType = 'synth'"` → `@click="focusedTrack!.engineType = 'synth'"`
- `:style="engineType === 'synth' ? …"` → `:style="focusedTrack!.engineType === 'synth' ? …"`

(Repeat for `kick`, `hat`, `snare`, `clap`.)

In the focused `<Tracker>`:
- `:engineType="engineType"` → `:engineType="focusedTrack!.engineType"`

In the five engine-panel `<template v-if/v-else-if>` conditions:
- `v-if="engineType === 'synth'"` → `v-if="focusedTrack!.engineType === 'synth'"`
- `v-else-if="engineType === 'kick'"` → `v-else-if="focusedTrack!.engineType === 'kick'"`
- `v-else-if="engineType === 'hat'"` → `v-else-if="focusedTrack!.engineType === 'hat'"`
- `v-else-if="engineType === 'snare'"` → `v-else-if="focusedTrack!.engineType === 'snare'"`
- `v-else-if="engineType === 'clap'"` → `v-else-if="focusedTrack!.engineType === 'clap'"`

- [ ] **Step 2: Remove `engineType` from the `App.vue` destructure**

Delete `engineType,` and `synthMode,` from the `useSynth()` destructure in `App.vue` (`synthMode` was removed from the return in Task 6; `engineType` is removed in this step's Step 3).

- [ ] **Step 3: Delete the `engineType` computed from `useSynth.ts`**

Delete:

```ts
  const engineType = computed({
    get: () => activeTrackIndex.value !== null ? project.tracks[activeTrackIndex.value].engineType : 'synth' as EngineType,
    set: (val: EngineType) => {
      if (activeTrackIndex.value !== null) project.tracks[activeTrackIndex.value].engineType = val;
    }
  });
```

And delete `engineType,` from the `return { … }` object. (`EngineType` is still imported and used by `getTrackEngineType`'s return type — keep it.)

- [ ] **Step 4: Verify typecheck + tests**

Run: `npm run typecheck:client && npm run test:client`
Expected: `vue-tsc` exits 0; all client tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/App.vue packages/client/src/composables/useSynth.ts
git commit -m "refactor(App): route engine-type through focusedTrack, drop engineType computed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Full verification + manual e2e + doc note

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Full workspace gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three green — `vue-tsc` (client) + `tsc` (server/shared) exit 0; full Vitest suite passes; `vite build` + esbuild server bundle succeed.

- [ ] **Step 2: Manual / Playwright behavior check**

This is the one regression the type system cannot catch (a typed-but-mis-wired binding). Start the client (`npm run dev:client`) and, in the focused view for a track:
1. Open the SYNTH engine, turn the **Cutoff** knob → the oscilloscope/audio changes and the knob's remote-activity path is `tracks.<i>.engines.synth.filterCutoff` (confirm via a second browser tab on the same room: the knob moves there too).
2. Turn an **OSC 2** knob (Coarse/Fine/Level) → confirm OSC 2's value changes, not OSC 1's (guards against a swapped binding).
3. Switch to a **drum** engine (e.g. KICK), turn **Tune/Decay/Click** → audio changes and broadcasts.
4. Toggle **MONO/POLY** → mode persists and broadcasts.

Expected: every knob edits the correct field, changes audio, and propagates to a second client. If any knob edits the wrong field, fix the `v-model="params.<field>"` to match the adjacent `ks.pathFor('<field>')`.

- [ ] **Step 3: Update `docs/ARCHITECTURE.md`**

If §2 (module map) or the decisions appendix describe the per-parameter `trackParam` writable-computed binding, update them to describe the slice-down binding (panels receive a reactive `:params` engine slice; `useSynth` exposes `focusedTrack`; the `trackParam` wall and both `v-model` walls are gone). Add a one-line decision entry (next id after D13) summarizing: "Panels bind directly to the reactive `project` engine slice via a single `:params` prop; the per-field writable-computed projection was removed (Phase 1 of the panel-binding refactor). Sync paths remain owned by `knobSync`."

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): document slice-down panel binding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria

- `useSynth.ts` no longer contains `trackParam`, the ~30 param refs, `engineType`, or `synthMode`; it exposes `focusedTrack`.
- `App.vue` passes exactly one `:params` prop per engine/drum panel; no `v-model:` param walls remain; engine-type reads/writes go through `focusedTrack`.
- Every panel binds its `<Knob>`s with `v-model="params.<field>"`, field names matching the adjacent `ks.pathFor('<field>')`.
- `npm run typecheck && npm test && npm run build` green; manual e2e confirms audio + sync still work per Task 8.
