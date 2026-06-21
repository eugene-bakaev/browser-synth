# Worklet Drum Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three AudioWorklet drum engines — `kick2`, `snare2`, `hat2` — alongside the existing main-thread drums, each with a "modern" default voicing and classic TR-808/909 factory presets, grounded in Gordon Reid's "Synth Secrets" (SOS).

**Architecture:** Mirror the proven `synth2` host/kernel/worklet split, once per engine. A shared descriptor table per engine is the single source of truth (params interface, defaults, Zod schema, kernel Float32Array block layout, panel knobs). Pure TS kernels do per-sample DSP and are unit-testable with no AudioContext; a thin worklet entry registers the processor; a `SoundEngine` host posts param blocks + triggers over a MessagePort. Engines are additive — existing sessions are untouched and users opt in via the engine selector.

**Tech Stack:** TypeScript, Vue 3 (`<script setup>`), Vite, Web Audio `AudioWorklet`, esbuild (worklet bundling), Zod (wire validation), Vitest.

## Global Constraints

- **Additive only.** Never modify `kick`/`snare`/`hat`/`clap` behavior. New engine types are `kick2`/`snare2`/`hat2`.
- **Descriptor tables are APPEND-ONLY once shipped.** The kernel block index == array position; inserting/reordering scrambles older clients' stored params.
- **Address the param block via `PARAM_INDEX['key']`, never positional literals.**
- **Worklet bundles are generated, not committed** (same as `synth2-processor.js`). Each new engine adds an esbuild command to `build:worklet` and an `addModule` await in `useSynth.buildAudioState`.
- **Kernel `noteOn(time,…)` schedules against the sample clock** (copy `Synth2Kernel`), so sequencer look-ahead stays sample-accurate. Drums ignore incoming note pitch/duration and voice themselves from params.
- **Gate before every merge:** `npm run typecheck && npm test && npm run build` (from repo root).
- **Browser-verify before "done"** (AGENTS.md / Stop hook): Playwright MCP, clean console, close the tab when finished.
- **Git:** branch per phase off `main`; stage specific files (never `git add -A`); keep merged branches; commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Spec / design reference:** `docs/DRUM_WORKLETS.md` (design + SOS recipes + append-an-engine checklist). The `synth2` files are the canonical templates: `packages/client/src/engine/Synth2Engine.ts`, `packages/client/src/engine/synth2/{worklet-entry.ts,kernel/params.ts,kernel/Synth2Kernel.ts}`, `packages/shared/src/engines/synth2-descriptors.ts`.

## File Structure

Per engine `<name>` ∈ {kick2, snare2, hat2}:

- `packages/shared/src/engines/<name>.ts` — descriptor table + params interface + `DEFAULT_<NAME>_PARAMS` (built via `buildDrumDefaults`, `drum-descriptors.ts`).
- `packages/shared/src/engines/<name>.test.ts` — descriptor↔defaults contract test.
- `packages/client/src/engine/<name>/kernel/params.ts` — `PARAM_INDEX`/`PARAM_COUNT`/`defaultParamBlock` from the table.
- `packages/client/src/engine/<name>/kernel/<Name>Kernel.ts` — pure DSP.
- `packages/client/src/engine/<name>/kernel/<Name>Kernel.test.ts` — DSP unit tests.
- `packages/client/src/engine/<name>/worklet-entry.ts` — `registerProcessor('<name>', …)`.
- `packages/client/src/engine/<Name>Engine.ts` — `SoundEngine` host.
- `packages/client/src/components/<Name>Panel.vue` — descriptor-driven knobs.

Shared wiring touched once per engine (the "append-an-engine" surface):
`shared/src/index.ts` (EngineType) · `shared/src/engines/index.ts` (export) · `shared/src/project/{schema.ts,types.ts,factory.ts,normalize.ts,accept-list.ts}` · `client/src/composables/useSynth.ts` · `client/src/project/{preset.ts,storage.ts}` · `client/src/views/StudioView.vue` · `client/package.json` (`build:worklet`).

Factory presets (Phase 2): `packages/client/src/project/factory-presets.ts` + a `<select>` in StudioView's `.preset-controls`.

---

## Phase 1 — kick2 walking skeleton ✅ DONE

Delivered on branch `feat/kick2-walking-skeleton` (commit `fc2cfe7`), gate green, browser-verified. Kept here for coverage; do not re-implement.

- [x] Shared `drum-descriptors.ts` + `kick2.ts` (params tune/punch/pitchDecay/decay/click/drive/droop/level) + contract test
- [x] Append-an-engine wiring across shared (EngineType, schema, types, factory, normalize, accept-list)
- [x] `Kick2Kernel` (+ unit tests) + `params.ts` + `worklet-entry.ts` + `Kick2Engine`
- [x] Client registration (useSynth factories/slices/addModule, preset/storage maps), `Kick2Panel.vue` (knob-row wraps), StudioView selector + slot, `build:worklet` bundle
- [x] `docs/DRUM_WORKLETS.md`

---

## Phase 2 — Factory presets (+ kick2 808/909/Modern)

**Branch:** `feat/drum-presets`. Adds a reusable factory-preset library and a single preset `<select>` in StudioView's preset controls (works for any engine; populated for kick2 now, snare2/hat2 in later phases). Reuses the existing `applyPreset(track, preset)` (`packages/client/src/project/preset.ts:92`).

### Task 2.1: Factory preset library + kick2 presets

**Files:**
- Create: `packages/client/src/project/factory-presets.ts`
- Create: `packages/client/src/project/factory-presets.test.ts`

**Interfaces:**
- Consumes: `Preset` and `makePreset` from `./preset`; `DEFAULT_KICK2_PARAMS` from `@fiddle/shared`; `ProjectSchema`/`Schemas` from `@fiddle/shared` for the validity test.
- Produces: `interface FactoryPreset { name: string; preset: Preset }`; `function factoryPresetsFor(engineType: EngineType): FactoryPreset[]` (empty array for engines with no curated presets yet).

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/project/factory-presets.test.ts
import { describe, it, expect } from 'vitest';
import { factoryPresetsFor } from './factory-presets';
import { Schemas } from '@fiddle/shared';

describe('factoryPresetsFor', () => {
  it('returns Modern/808/909 for kick2, each schema-valid', () => {
    const list = factoryPresetsFor('kick2');
    expect(list.map((f) => f.name)).toEqual(['Modern', '808', '909']);
    for (const { preset } of list) {
      expect(preset.engineType).toBe('kick2');
      // Each preset's params must satisfy the kick2 leaf schema.
      expect(Schemas.Kick2Params.safeParse(preset.params).success).toBe(true);
    }
  });

  it('returns [] for an engine with no curated presets', () => {
    expect(factoryPresetsFor('synth')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:client -- factory-presets`
Expected: FAIL — `factory-presets` module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/client/src/project/factory-presets.ts
import type { EngineType, Kick2EngineParams } from '@fiddle/shared';
import { DEFAULT_KICK2_PARAMS } from '@fiddle/shared';
import { makePreset, type Preset } from './preset';

export interface FactoryPreset {
  name: string;
  preset: Preset;
}

// Voicings grounded in SOS "Synth Secrets" bass-drum analyses. Each is the
// kick2 default with deliberate overrides; spread keeps them schema-complete.
const kick2 = (name: string, over: Partial<Kick2EngineParams>): FactoryPreset => ({
  name,
  preset: makePreset('kick2', { ...DEFAULT_KICK2_PARAMS, ...over }),
});

const KICK2_PRESETS: FactoryPreset[] = [
  kick2('Modern', {}),
  // TR-808: long, pure-ish sine, gentle click, a touch of droop, little drive.
  kick2('808', { tune: 48, punch: 0.35, pitchDecay: 0.05, decay: 0.9, click: 0.25, drive: 0.05, droop: 0.4 }),
  // TR-909: punchy, brighter click, more drive, shorter tail, no droop.
  kick2('909', { tune: 58, punch: 0.7, pitchDecay: 0.03, decay: 0.45, click: 0.7, drive: 0.4, droop: 0 }),
];

const REGISTRY: Partial<Record<EngineType, FactoryPreset[]>> = {
  kick2: KICK2_PRESETS,
};

export function factoryPresetsFor(engineType: EngineType): FactoryPreset[] {
  return REGISTRY[engineType] ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:client -- factory-presets`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/project/factory-presets.ts packages/client/src/project/factory-presets.test.ts
git commit -m "feat(presets): factory preset library + kick2 808/909/Modern"
```

### Task 2.2: Preset `<select>` in StudioView

**Files:**
- Modify: `packages/client/src/views/StudioView.vue` (`.preset-controls` block ~`:123-127`; `<script setup>` imports + handlers ~`:247-470`)

**Interfaces:**
- Consumes: `factoryPresetsFor`, `applyPreset`, the focused track (`project.tracks[activeTrackIndex.value]`).
- Produces: UI only.

- [ ] **Step 1: Add the dropdown to the template**

In `.preset-controls`, after the INIT PATCH button:

```vue
<select
  class="factory-preset-select"
  title="Apply a factory preset to this track"
  :value="''"
  @change="onApplyFactoryPreset(($event.target as HTMLSelectElement).value)"
>
  <option value="" disabled>PRESET…</option>
  <option v-for="fp in factoryPresets" :key="fp.name" :value="fp.name">{{ fp.name }}</option>
</select>
```

- [ ] **Step 2: Wire script — import, computed list, handler**

Add to `<script setup>` imports:

```ts
import { factoryPresetsFor } from '../project/factory-presets';
```

Add a computed + handler near the other preset handlers (`onSavePreset`, etc.):

```ts
const factoryPresets = computed(() =>
  focusedTrack.value ? factoryPresetsFor(focusedTrack.value.engineType) : [],
);

const onApplyFactoryPreset = (name: string) => {
  if (activeTrackIndex.value === null || !name) return;
  const fp = factoryPresets.value.find((f) => f.name === name);
  if (fp) applyPreset(project.tracks[activeTrackIndex.value], fp.preset);
};
```

(`applyPreset` is already imported at `StudioView.vue:250`; `computed` is already imported from Vue. `focusedTrack` is the existing focused-track computed.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:client`
Expected: no errors.

- [ ] **Step 4: Browser-verify**

Run dev (existing server on :5173). In a session, focus a kick2 track → pick `808` then `909` from PRESET… → confirm the panel knobs jump to the preset values and the kick audibly changes; check the console is clean; close the tab.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/views/StudioView.vue
git commit -m "feat(presets): factory-preset picker in the studio preset controls"
```

### Task 2.3: Gate + merge

- [ ] Run `npm run typecheck && npm test && npm run build` (expect green).
- [ ] Merge `--no-ff` into `main` after user review; keep the branch.

---

## Phase 3 — snare2

**Branch:** `feat/snare2`. Two tuned shell oscillators + a noise "wires" path split into HP-filtered and unfiltered bands with independent decays; `snappy` balances shell vs noise (SOS snare / TR-909 model). Follow the kick2 file structure exactly.

**Descriptor (append-only order):** `tune` (shell base Hz, 80–330, def 180), `ratio` (2nd partial multiple, 1.2–2.5, def 1.6), `bodyDecay` (s, 0.02–0.5, def 0.12), `noiseDecay` (s, 0.02–0.6, def 0.2), `snappy` (0–1, def 0.5), `tone` (noise band Hz, 800–6000, def 2200), `noiseHp` (HP cutoff Hz on the wires band, 200–4000, def 1200), `level` (0–1, def 0.9).

### Task 3.1: Shared descriptor + contract test + append-an-engine wiring

**Files:**
- Create: `packages/shared/src/engines/snare2.ts`, `packages/shared/src/engines/snare2.test.ts`
- Modify: `packages/shared/src/engines/index.ts`; `packages/shared/src/index.ts` (EngineType union add `'snare2'`); `packages/shared/src/project/schema.ts` (generate `Snare2ParamsSchema` from descriptors like kick2 `:62`-block, add to `EngineTypeSchema`/`EnginesMapSchema`/`Schemas`); `packages/shared/src/project/types.ts` (`Snare2EngineParams` import + `EngineParamsMap.snare2`); `packages/shared/src/project/factory.ts` (seed slice); `packages/shared/src/project/normalize.ts` (`ENGINE_KEYS` add `'snare2'`); `packages/shared/src/project/accept-list.ts` (`...SNARE2_DESCRIPTORS.map(d => ['tracks','*','engines','snare2', d.key])` + import)

**Interfaces:**
- Produces: `SNARE2_DESCRIPTORS`, `interface Snare2EngineParams { tune; ratio; bodyDecay; noiseDecay; snappy; tone; noiseHp; level }`, `DEFAULT_SNARE2_PARAMS`.

- [ ] **Step 1: Write the descriptor module** (mirror `kick2.ts`)

```ts
// packages/shared/src/engines/snare2.ts
import { buildDrumDefaults, type DrumParamDescriptor } from './drum-descriptors.js';

export const SNARE2_DESCRIPTORS = [
  { key: 'tune',       min: 80,  max: 330,  default: 180,  label: 'Tune',  format: 'hz' },
  { key: 'ratio',      min: 1.2, max: 2.5,  default: 1.6,  label: 'Ratio', format: 'percent' },
  { key: 'bodyDecay',  min: 0.02,max: 0.5,  default: 0.12, label: 'Body',  format: 'ms' },
  { key: 'noiseDecay', min: 0.02,max: 0.6,  default: 0.2,  label: 'Snares',format: 'ms' },
  { key: 'snappy',     min: 0,   max: 1,    default: 0.5,  label: 'Snap',  format: 'percent' },
  { key: 'tone',       min: 800, max: 6000, default: 2200, label: 'Tone',  format: 'hz' },
  { key: 'noiseHp',    min: 200, max: 4000, default: 1200, label: 'HP',    format: 'hz' },
  { key: 'level',      min: 0,   max: 1,    default: 0.9,  label: 'Level', format: 'percent' },
] as const satisfies readonly DrumParamDescriptor[];

export interface Snare2EngineParams {
  tune: number; ratio: number; bodyDecay: number; noiseDecay: number;
  snappy: number; tone: number; noiseHp: number; level: number;
}

export const DEFAULT_SNARE2_PARAMS: Snare2EngineParams =
  buildDrumDefaults<Snare2EngineParams>(SNARE2_DESCRIPTORS);
```

- [ ] **Step 2: Contract test** (copy `kick2.test.ts`, swap symbols to `SNARE2_*`/`Snare2EngineParams`).

- [ ] **Step 3: Wire the append-an-engine surface.** Apply the exact same edits made for kick2 (see `git show fc2cfe7` for the diff), substituting `snare2`/`Snare2`/`SNARE2`. Generate `Snare2ParamsSchema` exactly as the kick2 schema block (`schema.ts` — `Object.fromEntries(SNARE2_DESCRIPTORS.map(d => [d.key, z.number().min(d.min).max(d.max)]))`).

- [ ] **Step 4: Run** `npm run test -w @fiddle/shared` and `npm run typecheck` — expect green.

- [ ] **Step 5: Commit** `git commit -m "feat(snare2): shared descriptor + append-an-engine wiring"`

### Task 3.2: Snare2Kernel + params + unit tests

**Files:**
- Create: `packages/client/src/engine/snare2/kernel/params.ts` (copy kick2's, import `SNARE2_DESCRIPTORS`)
- Create: `packages/client/src/engine/snare2/kernel/Snare2Kernel.ts`
- Create: `packages/client/src/engine/snare2/kernel/Snare2Kernel.test.ts`

**Interfaces:**
- Produces: `class Snare2Kernel { constructor(sampleRate); applyParams(block); noteOn(time, freq, duration, velocity); process(out, frames, blockStartFrame) }` (same shape as `Kick2Kernel`).

- [ ] **Step 1: Write the DSP** — two shell sines (`tune`, `tune*ratio`) into a triangle-ish body with `bodyDecay`; white noise through a 1-pole HP at `noiseHp` (wires band) plus an unfiltered noise band, summed with `noiseDecay`; a 1-pole BP-ish tilt at `tone`; mix `body*(1-snappy)` + `noise*snappy`, `*velocity*level`. Reuse the kick2 xorshift noise + event-queue scheduling verbatim.

```ts
// packages/client/src/engine/snare2/kernel/Snare2Kernel.ts (core render loop sketch)
// state: phaseA, phaseB, t, velocity, hpPrevIn, hpPrevOut
const bodyEnv = Math.exp(-t * 6.9 / bodyDecay);
const a = Math.sin(this.phaseA), b = Math.sin(this.phaseB);
const body = (a + 0.6 * b) * bodyEnv;                  // tuned two-tone shell
const n = this.noise();
const hp = this.hpA * (this.hpPrevOut + n - this.hpPrevIn); // 1-pole HP @ noiseHp
this.hpPrevIn = n; this.hpPrevOut = hp;
const noiseEnv = Math.exp(-t * 6.9 / noiseDecay);
const wires = (0.7 * hp + 0.3 * n) * noiseEnv;
out[i] += (body * (1 - snappy) + wires * snappy) * this.velocity * level;
```

(`this.hpA = Math.exp(-2*Math.PI*noiseHp/sampleRate)` computed per render block from the param.)

- [ ] **Step 2: Unit tests** (mirror `Kick2Kernel.test.ts`): silence with no trigger; energy after a trigger; decays early≫late; all-finite & bounded; `snappy=1` yields more high-frequency content (more zero-crossings) than `snappy=0`.

- [ ] **Step 3: Run** `npm run test:client -- snare2` — expect green.

- [ ] **Step 4: Commit** `git commit -m "feat(snare2): DSP kernel + unit tests"`

### Task 3.3: Worklet entry + host + client registration + panel + presets + browser-verify

**Files:**
- Create: `packages/client/src/engine/snare2/worklet-entry.ts` (copy kick2's; `registerProcessor('snare2', …)`)
- Create: `packages/client/src/engine/Snare2Engine.ts` (copy `Kick2Engine.ts`; `engineType='snare2'`, node name `'snare2'`)
- Create: `packages/client/src/components/Snare2Panel.vue` (copy `Kick2Panel.vue`; `SNARE2_DESCRIPTORS`, `useKnobSync('snare2')`, heading "Snare 2 · Worklet")
- Modify: `packages/client/src/composables/useSynth.ts` (import, `snare2WorkletUrl`, `addModule`, `engineFactories.snare2`, `ENGINE_SLICES`)
- Modify: `packages/client/src/project/preset.ts` (`DEFAULTS.snare2`, `ALL_ENGINE_TYPES`) and `packages/client/src/project/storage.ts` (engines map)
- Modify: `packages/client/src/views/StudioView.vue` (SNARE2 selector button + panel `v-else-if` + import)
- Modify: `packages/client/package.json` (`build:worklet` — append `&& esbuild src/engine/snare2/worklet-entry.ts --bundle --format=esm --outfile=public/worklets/snare2-processor.js`)
- Modify: `packages/client/src/project/factory-presets.ts` (add `SNARE2_PRESETS`: Modern/808/909) + extend its test

- [ ] **Step 1–6:** Apply each edit above (each is a one-spot change identical in shape to the kick2 equivalent — see `git show fc2cfe7`). Add snare2 808/909 voicings to factory presets.
- [ ] **Step 7: Gate** `npm run typecheck && npm test && npm run build` — expect green; confirm `snare2-processor.js` emits.
- [ ] **Step 8: Browser-verify** — select SNARE2, place steps, Play, confirm a snare with body+snares, presets switch audibly, console clean, close tab.
- [ ] **Step 9: Commit** `git commit -m "feat(snare2): worklet + host + registration + panel + presets"` then merge `--no-ff` after review.

---

## Phase 4 — hat2

**Branch:** `feat/hat2`. Six enharmonic square oscillators (reuse the documented 808 cluster already in `HatEngine.ts:104` — `[205.3, 369.6, 304.4, 522.7, 370.0, 800.0]`) → 1-pole HP (`hpf`) + band tilt (`tone`) → envelope; `metallic` crossfades the osc cluster vs white noise; `ring` adds ring-mod between two cluster members; `decay` sets closed↔open length.

**Descriptor (append-only):** `tone` (band Hz, 3000–14000, def 9000), `decay` (s, 0.02–0.8, def 0.08), `hpf` (HP Hz, 3000–12000, def 7000), `metallic` (0–1, def 0.7), `ring` (0–1, def 0.2), `level` (0–1, def 0.8).

### Task 4.1: Shared descriptor + contract test + wiring
Same shape as Task 3.1, substituting `hat2`/`Hat2`/`HAT2`. Commit `feat(hat2): shared descriptor + append-an-engine wiring`.

### Task 4.2: Hat2Kernel + params + unit tests

- [ ] **Step 1: DSP** — sum six squares at the fixed cluster freqs; optional `ring` = `sq(f0)*sq(f1)` blended by `ring`; 1-pole HP at `hpf`; crossfade `osc*metallic + noise*(1-metallic)`; AD env with `decay`; `*velocity*level`.

```ts
// core: sq via Math.sign(Math.sin(phase)); accumulate 6 phases; ringMod = s0 * s3;
const cluster = (sum / 6) * (1 - ring) + ringMod * ring;
const hp = this.hpA * (this.hpPrevOut + cluster - this.hpPrevIn);
const env = Math.exp(-t * 6.9 / decay);
out[i] += ((hp * metallic) + (this.noise() * (1 - metallic))) * env * this.velocity * level;
```

- [ ] **Step 2: Unit tests** (mirror kick2): silence/trigger/decay/finite; `metallic=1` differs spectrally from `metallic=0`; longer `decay` ⇒ more total energy (open vs closed).
- [ ] **Step 3:** `npm run test:client -- hat2` green. **Step 4:** Commit `feat(hat2): DSP kernel + unit tests`.

### Task 4.3: Worklet + host + registration + panel + presets + browser-verify
Same shape as Task 3.3 (`hat2`). Add hat2 808/closed+open factory presets. Gate, browser-verify (closed and open via decay/presets), commit, merge after review.

---

## Self-Review

- **Spec coverage:** kick2 ✅ (Phase 1); presets ✅ (Phase 2, both modern defaults + 808/909); snare2 ✅ (Phase 3); hat2 ✅ (Phase 4). Both-as-presets and worklet-per-engine decisions honored. SOS recipes mapped per engine.
- **Placeholder scan:** Phases 3–4 wiring steps point at the concrete kick2 diff (`fc2cfe7`) rather than re-printing identical boilerplate — acceptable per task right-sizing (mechanical, one-spot edits with exact files listed). Genuinely new code (kernels, presets, the StudioView picker) is shown in full.
- **Type consistency:** every kernel uses the same `Kick2Kernel`-shaped public API; descriptor keys match each params interface (asserted by per-engine contract tests); `factoryPresetsFor`/`FactoryPreset` names are stable across Tasks 2.1/2.2/3.3/4.3.
