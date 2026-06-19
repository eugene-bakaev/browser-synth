# Synth2 Per-Module Wave Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small static waveform thumbnail next to each synth2 oscillator (OSC 1/2/3) and LFO (LFO 1/2) showing the shape that module currently generates, drawn from the real kernel DSP and repainted when a shape knob moves.

**Architecture:** A pure render helper (`wavePreview.ts`) is the only code that touches kernel DSP — it runs the real `MorphOscillator` for oscillators and the engine's own `Lfo.wave` for LFOs, returning a `Float32Array` of bipolar samples. A dumb `WavePreview.vue` paints that buffer on a 2D canvas and recomputes it reactively when its shape props change (no animation loop). `Synth2Panel.vue` drops five instances into the existing osc/LFO module cards. No worklet, schema, sync, persistence, or kernel-hot-path changes.

**Tech Stack:** Vue 3 (`<script setup>`, raw `createApp` mounts in tests — **no** `@vue/test-utils`), TypeScript, Vitest (jsdom for component tests), 2D Canvas, npm workspaces (`@fiddle/client`, `@fiddle/shared`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-19-synth2-wave-preview-design.md`. Branch: `feat/synth2-wave-preview` (already created off `main`; do **not** commit to `main`).
- Commit only the files each task names — never `git add -A` / `git add .`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- `SYNTH2_DESCRIPTORS` is **append-only and read-only here** — this feature never edits the descriptor table, schema, sync accept-list, or worklet.
- Preview constants (verbatim from spec §4): `PREVIEW_POINTS = 512`, `PREVIEW_CYCLES = 3`, `PREVIEW_SR = 48000`; `dt = PREVIEW_CYCLES / PREVIEW_POINTS`; `displayFreq = dt * PREVIEW_SR`.
- The preview is **static** (repaint on shape-prop change only) — **no `requestAnimationFrame`**.
- The preview is a **read-only projection** of existing params: it adds no reactive state, stores nothing, serializes nothing, sends nothing over the wire.
- Component tests run under jsdom, which has **no real 2D canvas** (`canvas.getContext('2d')` returns `null`) — drawing code must guard a null context and no-op (the visible drawing is verified in the browser, like the existing untested `Visualizer.vue`).
- **Gate (must be green before the feature is considered done, run from repo root):**
  `npm run typecheck && npm test && npm run build`. The build must still emit `packages/client/public/worklets/synth2-processor.js`.
- **Browser verification is MANDATORY** before reporting the feature done (AGENTS.md): drive the running dev app via the Playwright MCP, confirm the behavior and a clean console, then close the tab/session and stop the dev server. Green unit tests are not a substitute.

---

### Task 1: Render helper (`wavePreview.ts`) + expose `Lfo.wave`

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Lfo.ts:36` (widen `private static wave` → `static wave`)
- Create: `packages/client/src/engine/synth2/preview/wavePreview.ts`
- Test: `packages/client/src/engine/synth2/preview/wavePreview.test.ts`

**Interfaces:**
- Consumes (existing, do not change):
  - `class MorphOscillator` — `constructor(morph, pulseWidth, coarse, fine, sampleRate: number)` (all four are `ParamSlot`); `next(baseFreq: number, fmInput?: number, fmAmount?: number, syncReset?: number): number`; public field `wrapped: boolean` (set every `next()`); `reset(): void`.
  - `class Lfo` — `static wave(s: number, p: number): number` (made public in this task; morph 0..4: sine→tri→saw-up→saw-down→square at phase `p ∈ [0,1)`).
  - `class ParamSlot` — `constructor(desc: Synth2ParamDescriptor, sampleRate: number)`. Constructor sets `current = target = desc.default`, so `next()` returns `desc.default` immediately (no smoother ramp) when `mod === 0`; `next()` clamps a non-finite result to `desc.min`.
  - `PARAM_INDEX: Record<string, number>` and `SYNTH2_DESCRIPTORS: ReadonlyArray<Synth2ParamDescriptor>` (key `'osc1.morph'` etc. exist; osc1/2/3 share identical descriptor ranges).
- Produces (later tasks rely on these exact names/types):
  - `renderOscShape(morph: number, pulseWidth: number): Float32Array` — length `PREVIEW_POINTS`, bipolar samples.
  - `renderLfoShape(shape: number): Float32Array` — length `PREVIEW_POINTS`, bipolar samples.
  - Exported consts `PREVIEW_POINTS`, `PREVIEW_CYCLES`, `PREVIEW_SR`.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/engine/synth2/preview/wavePreview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderOscShape, renderLfoShape, PREVIEW_POINTS, PREVIEW_CYCLES } from './wavePreview';
import { Lfo } from '../kernel/Lfo';

const finite = (buf: Float32Array) => buf.every((v) => Number.isFinite(v));
const maxAbs = (buf: Float32Array) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const mean = (buf: Float32Array) => buf.reduce((s, v) => s + v, 0) / buf.length;

describe('renderOscShape', () => {
  it('returns PREVIEW_POINTS finite samples bounded to ~[-1,1]', () => {
    const buf = renderOscShape(0, 0.5);
    expect(buf.length).toBe(PREVIEW_POINTS);
    expect(finite(buf)).toBe(true);
    expect(maxAbs(buf)).toBeLessThanOrEqual(1.05);
  });

  it('sine (morph 0) is phase-aligned: starts ~0, rises, ~zero DC', () => {
    const buf = renderOscShape(0, 0.5);
    expect(Math.abs(buf[0])).toBeLessThan(0.05);
    expect(buf[1]).toBeGreaterThan(buf[0]);
    expect(Math.abs(mean(buf))).toBeLessThan(0.05);
  });

  it('saw (morph 2) spans the full range with exactly PREVIEW_CYCLES sharp falls', () => {
    const buf = renderOscShape(2, 0.5);
    expect(maxAbs(buf)).toBeGreaterThan(0.9);
    let falls = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i] - buf[i - 1] < -1.0) falls++;
    expect(falls).toBe(PREVIEW_CYCLES);
  });

  it('pulse (morph 3) high-fraction tracks pulseWidth', () => {
    const highFrac = (pw: number) => {
      const buf = renderOscShape(3, pw);
      return buf.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) / buf.length;
    };
    expect(highFrac(0.25)).toBeGreaterThan(0.15);
    expect(highFrac(0.25)).toBeLessThan(0.35);
    expect(highFrac(0.75)).toBeGreaterThan(0.65);
  });

  it('garbage params stay finite and correctly sized (hardening)', () => {
    const buf = renderOscShape(NaN, NaN);
    expect(buf.length).toBe(PREVIEW_POINTS);
    expect(finite(buf)).toBe(true);
  });

  it('is deterministic', () => {
    expect([...renderOscShape(1.4, 0.5)]).toEqual([...renderOscShape(1.4, 0.5)]);
  });
});

describe('renderLfoShape', () => {
  it('equals Lfo.wave at the same phases (single source of truth)', () => {
    const buf = renderLfoShape(2.3);
    expect(buf.length).toBe(PREVIEW_POINTS);
    for (let i = 0; i < PREVIEW_POINTS; i++) {
      const phase = ((i / PREVIEW_POINTS) * PREVIEW_CYCLES) % 1;
      expect(buf[i]).toBeCloseTo(Lfo.wave(2.3, phase), 6);
    }
  });

  it('sine (shape 0) is bounded + ~zero DC; square (shape 4) is ±1', () => {
    const sine = renderLfoShape(0);
    expect(maxAbs(sine)).toBeLessThanOrEqual(1.0001);
    expect(Math.abs(mean(sine))).toBeLessThan(0.05);
    for (const v of renderLfoShape(4)) expect(Math.abs(v)).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:client -- wavePreview`
Expected: FAIL — `wavePreview.ts` does not exist (import error) / `Lfo.wave` is private.

- [ ] **Step 3: Expose `Lfo.wave`**

In `packages/client/src/engine/synth2/kernel/Lfo.ts`, change the method visibility only (no body change):

```ts
  /** Morphed shape s∈[0,4] at phase p∈[0,1): linear crossfade of two neighbours. */
  static wave(s: number, p: number): number {
```

(Leave `private static base(...)` private — `wave` is the only one the preview needs.)

- [ ] **Step 4: Implement the render helper**

Create `packages/client/src/engine/synth2/preview/wavePreview.ts`:

```ts
// Per-module wave-shape preview (spec 2026-06-19): the bipolar samples each
// synth2 oscillator / LFO actually generates, drawn from the REAL kernel DSP
// (MorphOscillator for oscs, Lfo.wave for LFOs) at a fixed representative
// display pitch. Pure data — no canvas, no audio context. This is the ONLY
// place the UI touches kernel DSP; the Vue layer just paints the buffer.

import { MorphOscillator } from '../kernel/MorphOscillator';
import { Lfo } from '../kernel/Lfo';
import { ParamSlot } from '../kernel/ParamSlot';
import { PARAM_INDEX } from '../kernel/params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

/** Samples captured = polyline points drawn. */
export const PREVIEW_POINTS = 512;
/** Cycles shown so the thumbnail reads as a repeating "wave". */
export const PREVIEW_CYCLES = 3;
/** Nominal sample rate — the preview is a drawing, not the audio context. */
export const PREVIEW_SR = 48000;

/** Samples advanced before capture so the triangle leaky-integrator settles. */
const WARMUP_SAMPLES = 1024;
/** Per-sample phase increment: PREVIEW_CYCLES cycles across PREVIEW_POINTS. */
const DT = PREVIEW_CYCLES / PREVIEW_POINTS;
/** Pitch fed to the oscillator so f / PREVIEW_SR === DT (coarse/fine neutral). */
const DISPLAY_FREQ = DT * PREVIEW_SR;

// Real descriptors give the preview slots the engine's true min/max/taper, so
// ParamSlot's clamp matches production. We override `default` with the desired
// value: the ctor sets current=target=default, so next() returns it with no
// smoother ramp (no smoother warm-up needed). All three oscs share identical
// descriptor ranges, so osc1's descriptors serve every oscillator.
const OSC_MORPH = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.morph']];
const OSC_PW = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.pulseWidth']];
const OSC_COARSE = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.coarse']];
const OSC_FINE = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.fine']];

const slotWithValue = (desc: Synth2ParamDescriptor, value: number): ParamSlot =>
  new ParamSlot({ ...desc, default: value }, PREVIEW_SR);

/**
 * Bipolar samples (≈ −1..+1) of one oscillator's morphed shape over
 * PREVIEW_CYCLES cycles, produced by the real MorphOscillator (PolyBLEP edges,
 * leaky-integrator triangle). Length === PREVIEW_POINTS.
 */
export function renderOscShape(morph: number, pulseWidth: number): Float32Array {
  const osc = new MorphOscillator(
    slotWithValue(OSC_MORPH, morph),
    slotWithValue(OSC_PW, pulseWidth),
    slotWithValue(OSC_COARSE, 0),
    slotWithValue(OSC_FINE, 0),
    PREVIEW_SR,
  );
  // Settle the triangle integrator.
  for (let i = 0; i < WARMUP_SAMPLES; i++) osc.next(DISPLAY_FREQ);
  // Phase-align: start capture at a wrap (phase ≈ 0) so the drawing doesn't
  // slide horizontally as the user sweeps morph.
  while (!osc.wrapped) osc.next(DISPLAY_FREQ);
  const out = new Float32Array(PREVIEW_POINTS);
  for (let i = 0; i < PREVIEW_POINTS; i++) out[i] = osc.next(DISPLAY_FREQ);
  return out;
}

/**
 * Bipolar samples of one LFO's morphed shape over PREVIEW_CYCLES cycles,
 * produced by the engine's own Lfo.wave (naive by design ⇒ exact at any
 * sampling). Length === PREVIEW_POINTS.
 */
export function renderLfoShape(shape: number): Float32Array {
  const out = new Float32Array(PREVIEW_POINTS);
  for (let i = 0; i < PREVIEW_POINTS; i++) {
    const phase = ((i / PREVIEW_POINTS) * PREVIEW_CYCLES) % 1;
    out[i] = Lfo.wave(shape, phase);
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:client -- wavePreview`
Expected: PASS (all 8 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:client`
Expected: PASS (no errors).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Lfo.ts \
        packages/client/src/engine/synth2/preview/wavePreview.ts \
        packages/client/src/engine/synth2/preview/wavePreview.test.ts
git commit -m "$(cat <<'EOF'
feat(synth2): wave-preview render helper from real kernel DSP

renderOscShape runs the real MorphOscillator (warm-up + phase-align + capture
3 cycles); renderLfoShape samples the engine's own Lfo.wave (now public).
Pure data, no canvas/audio context. Read-only use of the descriptor table.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `WavePreview.vue` canvas painter

**Files:**
- Create: `packages/client/src/components/WavePreview.vue`
- Test: `packages/client/src/components/WavePreview.test.ts`

**Interfaces:**
- Consumes: `renderOscShape(morph, pulseWidth): Float32Array`, `renderLfoShape(shape): Float32Array` from `../engine/synth2/preview/wavePreview` (Task 1).
- Produces: a component with props `{ kind: 'osc' | 'lfo'; morph?: number; pulseWidth?: number; shape?: number; color?: string }` that renders a `<div class="wave-preview"><canvas></canvas></div>`, recomputes its sample buffer reactively when a shape prop changes, and paints on a 2D canvas (no-op when no 2D context). No `requestAnimationFrame`.

- [ ] **Step 1: Write the failing tests**

Create `packages/client/src/components/WavePreview.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, reactive, h, nextTick, type App } from 'vue';
import WavePreview from './WavePreview.vue';
import * as preview from '../engine/synth2/preview/wavePreview';

// jsdom has no real 2D canvas, so painting no-ops. Mock the helper so we can
// assert reactivity without needing a canvas context; the helper's real
// behavior is covered by wavePreview.test.ts.
vi.mock('../engine/synth2/preview/wavePreview', () => ({
  renderOscShape: vi.fn(() => new Float32Array(4)),
  renderLfoShape: vi.fn(() => new Float32Array(4)),
}));

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

function mount(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(WavePreview, props);
  app.mount(host);
  return host;
}

describe('WavePreview', () => {
  it('renders a canvas for kind="osc" without throwing', () => {
    const el = mount({ kind: 'osc', morph: 1.4, pulseWidth: 0.5, color: '#fff' });
    expect(el.querySelector('.wave-preview canvas')).not.toBeNull();
  });

  it('renders a canvas for kind="lfo" without throwing', () => {
    const el = mount({ kind: 'lfo', shape: 2.5, color: '#fff' });
    expect(el.querySelector('.wave-preview canvas')).not.toBeNull();
  });

  it('does not throw on NaN params (hardening)', () => {
    const el = mount({ kind: 'osc', morph: NaN, pulseWidth: NaN, color: '#fff' });
    expect(el.querySelector('.wave-preview canvas')).not.toBeNull();
  });

  it('recomputes the buffer when a shape prop changes', async () => {
    const calls = vi.mocked(preview.renderOscShape);
    calls.mockClear();
    const state = reactive({ morph: 0 });
    host = document.createElement('div');
    document.body.appendChild(host);
    app = createApp({
      render: () => h(WavePreview, { kind: 'osc', morph: state.morph, pulseWidth: 0.5, color: '#fff' }),
    });
    app.mount(host);
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(1);
    const before = calls.mock.calls.length;
    state.morph = 2;
    await nextTick();
    expect(calls.mock.calls.length).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:client -- WavePreview`
Expected: FAIL — `WavePreview.vue` does not exist.

- [ ] **Step 3: Implement the component**

Create `packages/client/src/components/WavePreview.vue`:

```vue
<template>
  <div class="wave-preview">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { renderOscShape, renderLfoShape } from '../engine/synth2/preview/wavePreview';

const props = withDefaults(
  defineProps<{
    kind: 'osc' | 'lfo';
    morph?: number;
    pulseWidth?: number;
    shape?: number;
    color?: string;
  }>(),
  { morph: 0, pulseWidth: 0.5, shape: 0, color: '#00f0ff' },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const VPAD = 0.9; // headroom so a full-scale wave isn't clipped at the canvas edge

// Compute (cheap, pure) separated from paint (canvas) so the buffer recomputes
// reactively even where there is no 2D context (tests).
const samples = computed<Float32Array>(() =>
  props.kind === 'lfo' ? renderLfoShape(props.shape) : renderOscShape(props.morph, props.pulseWidth),
);

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
}

function draw(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // jsdom / no 2d support → no-op (visible draw verified in browser)
  const { width, height } = canvas;
  if (width === 0 || height === 0) return;
  const dpr = window.devicePixelRatio || 1;

  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#1d293d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const buf = samples.value;
  ctx.beginPath();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = props.color;
  ctx.shadowColor = props.color;
  ctx.shadowBlur = 6 * dpr;
  for (let i = 0; i < buf.length; i++) {
    const x = (i / (buf.length - 1)) * width;
    const y = height / 2 - buf[i] * (height / 2) * VPAD;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function onResize(): void {
  resizeCanvas();
  draw();
}

// Repaint when the buffer or color changes — static, no animation loop.
watch([samples, () => props.color], draw, { flush: 'post' });

onMounted(() => {
  resizeCanvas();
  draw();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});
</script>

<style scoped>
.wave-preview {
  width: 100%;
  height: 44px;
  margin-top: 6px;
  border: 1px solid #0f172a;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.wave-preview canvas {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
}
</style>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:client -- WavePreview`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:client`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/WavePreview.vue \
        packages/client/src/components/WavePreview.test.ts
git commit -m "$(cat <<'EOF'
feat(synth2): WavePreview canvas component (static, reactive)

Paints the helper's sample buffer on a 2D canvas; recomputes reactively on
shape-prop change via a computed, no rAF loop. Null-context-safe for jsdom.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire five previews into `Synth2Panel.vue`

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (import + 5 `<WavePreview>` placements; `<script setup>` import near line 207)
- Test: `packages/client/src/components/Synth2Panel.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `WavePreview` (Task 2) with props `kind`, `morph`, `pulseWidth`, `shape`, `color`. The panel already receives `color` and passes it to `Visualizer`; reuse it. Osc params live at `params.osc1|osc2|osc3.{morph,pulseWidth}`; LFO at `params.lfo1|lfo2.shape`.
- Produces: rendered DOM where each of the OSC 1/2/3 and LFO 1/2 `.module-group`s contains exactly one `.wave-preview` (5 total).

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/components/Synth2Panel.test.ts`:

```ts
describe('Synth2Panel wave previews (2026-06-19)', () => {
  it('renders exactly five wave previews (osc1/2/3 + lfo1/2)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(el.querySelectorAll('.wave-preview').length).toBe(5);
  });

  it('places a wave preview inside each osc and LFO module group (and nowhere else)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const headingsWithPreview = Array.from(el.querySelectorAll('.module-group'))
      .filter((g) => g.querySelector('.wave-preview'))
      .map((g) => g.querySelector('h3')?.textContent?.trim())
      .sort();
    expect(headingsWithPreview).toEqual(['LFO 1', 'LFO 2', 'OSC 1', 'OSC 2', 'OSC 3']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:client -- Synth2Panel`
Expected: FAIL — 0 `.wave-preview` elements found (expected 5).

- [ ] **Step 3: Import `WavePreview` in the panel**

In `packages/client/src/components/Synth2Panel.vue`, add the import alongside the existing ones in `<script setup>` (next to `import Visualizer from './Visualizer.vue';`):

```ts
import WavePreview from './WavePreview.vue';
```

- [ ] **Step 4: Add the preview to OSC 1**

In the OSC 1 `module-group`, immediately after the `</div>` that closes its `.knob-row` (the row of Morph/PW/Coarse/Fine/Level knobs) and before the `</div>` that closes the `module-group`, insert:

```html
        <WavePreview kind="osc" :morph="params.osc1.morph" :pulseWidth="params.osc1.pulseWidth" :color="color" />
```

- [ ] **Step 5: Add the preview to OSC 2 and OSC 3**

In the OSC 2 `module-group`, immediately after its `.knob-row` closing `</div>` and **before** the `<button ... class="sync-btn">`, insert:

```html
        <WavePreview kind="osc" :morph="params.osc2.morph" :pulseWidth="params.osc2.pulseWidth" :color="color" />
```

In the OSC 3 `module-group`, in the same position (after its `.knob-row`, before its `sync-btn`), insert:

```html
        <WavePreview kind="osc" :morph="params.osc3.morph" :pulseWidth="params.osc3.pulseWidth" :color="color" />
```

- [ ] **Step 6: Add the preview to LFO 1 and LFO 2**

In the LFO 1 `module-group` (heading `LFO 1`), after its `.knob-row` closing `</div>` and before the `module-group` closing `</div>`, insert:

```html
        <WavePreview kind="lfo" :shape="params.lfo1.shape" :color="color" />
```

In the LFO 2 `module-group` (heading `LFO 2`), in the same position, insert:

```html
        <WavePreview kind="lfo" :shape="params.lfo2.shape" :color="color" />
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:client -- Synth2Panel`
Expected: PASS (both new tests, plus all pre-existing Synth2Panel tests still green).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck:client`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue \
        packages/client/src/components/Synth2Panel.test.ts
git commit -m "$(cat <<'EOF'
feat(synth2): show a wave preview on each osc and LFO in Synth2Panel

Five WavePreview thumbnails (osc1/2/3 morph+PW, lfo1/2 shape), reusing the
panel's track color. UI-only; params are read, never mutated.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Full gate + browser verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate from the repo root**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS across all workspaces; build emits `packages/client/public/worklets/synth2-processor.js`.

- [ ] **Step 2: Start the dev app**

Run: `npm run dev` (leave running in the background).
Expected: client serves on its Vite port; worklet built.

- [ ] **Step 3: Browser-verify via the Playwright MCP**

Drive the running app with the Playwright MCP:
1. Open/create a session; add a synth2 track; open Synth2Panel.
2. OSC 1: sweep `Morph` 0→3 and confirm the thumbnail morphs sine → triangle → saw → pulse; at the pulse end, turn `PW` and confirm the duty cycle visibly changes. Spot-check OSC 2 / OSC 3.
3. LFO 1: sweep `Shape` 0→4 and confirm sine → triangle → saw-up → saw-down → square. Spot-check LFO 2.
4. Confirm the preview is static (no animation) and repaints only on knob change; confirm the browser console is clean (no errors/warnings from the preview).
Report the observed behavior and the console state.

- [ ] **Step 4: Clean up**

Close the Playwright tab/session; stop the `npm run dev` server.

- [ ] **Step 5: Keep the branch for user review**

Do **not** merge. Report completion (gate + browser observations) and leave `feat/synth2-wave-preview` in place for the user to browser-verify before they decide on merge.

---

## Self-Review

**1. Spec coverage:**
- §1 goal (per-osc/LFO shape thumbnail) → Tasks 2–3. ✓
- §2/§3.1 computed preview, no worklet change → no worklet/audio files touched. ✓
- §3.2/§4 Option B accuracy (real `MorphOscillator` + `Lfo.wave`, display pitch) → Task 1 `renderOscShape`/`renderLfoShape` + constants. ✓
- §3.2/§3.3 static, shape params only (osc morph+PW; LFO shape) → Task 1 signatures + Task 2 `samples` computed + Task 3 prop bindings. ✓
- §3.4 five modules → Task 3 placement test asserts exactly OSC 1/2/3 + LFO 1/2. ✓
- §5.1 helper as sole kernel-DSP touch-point; `Lfo.wave` exposed → Task 1. ✓
- §5.2 dumb canvas painter, dpr sizing, no rAF, null-ctx guard → Task 2. ✓
- §5.3 placement under each knob-row, reuse `color` → Task 3 steps 4–6. ✓
- §6 read-only data flow → Task 3 commit note + tests mutate nothing. ✓
- §7 perf (compute on change, no loop) → Task 2 `watch`/`computed`, no rAF. ✓
- §8 edge cases (NaN, null ctx, zero size, dpr) → Task 1 NaN test + Task 2 guards/NaN test. ✓
- §9 tests (unit/component/panel/gate/browser) → Tasks 1–4. ✓
- §11 file list → matches Tasks 1–3 exactly. ✓
- Refinement vs spec §9: spec floated "spy on the helper or assert internal buffer" for the component reactivity test under jsdom; because `draw()` bails before painting where there is no 2D context, Task 2 separates a pure `computed` (`samples`) from paint and asserts the helper is re-invoked via `vi.mock` on prop change — satisfying the intent. Noted, not a gap.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to"/bare prose steps — every code step shows complete code. ✓

**3. Type consistency:** `renderOscShape(morph, pulseWidth)`, `renderLfoShape(shape)`, `PREVIEW_POINTS`/`PREVIEW_CYCLES`/`PREVIEW_SR`, and props `kind/morph/pulseWidth/shape/color` are spelled identically across Tasks 1→2→3 and the tests. `MorphOscillator`/`ParamSlot`/`Lfo.wave`/`PARAM_INDEX`/`SYNTH2_DESCRIPTORS` match the signatures verified in the kernel sources. ✓
