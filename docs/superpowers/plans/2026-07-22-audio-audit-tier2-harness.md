# Audio Audit Sub-project B — Tier-2 Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a whole saved project offline through the real browser audio graph (Playwright-driven `OfflineAudioContext`), making the sequencer and v1 engines reachable, and prove it with a thin onset-timing-vs-grid check set.

**Architecture:** Extract the step→trigger mapping into one pure function (`resolveStepTriggers`) that live playback and the offline render both call, so they can't drift. Move the graph primitives into a Vue-free `audio/graph.ts` the harness can import without pulling Vue. A tiny Vite root inside `audio-lab` renders in a headless browser; a Node driver starts its own server + browser, evaluates the render, and hands samples to the existing analysis core. A committed fixture + three onset checks run on demand behind `lab:tier2`.

**Tech Stack:** TypeScript, Web Audio `OfflineAudioContext`, Vite ^5 (harness dev server), Playwright ^1.49 (headless chromium), Vitest ^4 (`@fiddle/audio-lab`), `@fiddle/client` + `@fiddle/shared` (workspace deep imports).

## Global Constraints

- **Branch:** `feat/audio-lab-tier2` (already created off `main` @ `44a2fd6`). Never commit on `main`.
- **No DSP changes** to any engine. This cycle only extracts, wires, and measures.
- **No bit-exact assertions.** Worklet kernels seed PRNGs with `Math.random()` → Tier-2 renders are sample-level non-deterministic. Every check is structural / tolerance-based.
- **`graph.ts` stays Vue-free** (verified: nothing under `src/engine/**` imports Vue). The harness bundle must not pull Vue.
- **The driver never touches the user's dev servers.** It starts its own Vite server on its own port (base 5190, `strictPort: false` so it auto-bumps if busy) and its own headless chromium, and tears both down in `finally`.
- **On-demand path stays out of `npm test` / the merge gate.** Browser-launching tests use the `*.tier2.test.ts` suffix, are excluded from the default vitest config, and run only via `npm run lab:tier2`.
- **Sample rate = 48000.** `stepDuration(bpm) = (60 / bpm) / 4`; 16 steps per bar.
- **Live behavior must be browser-verified unchanged** after each client change (Tasks 2 and 3) — real playback in `npm run dev:obs`, sound plays, console clean. `dev:obs` uses the LOCAL Docker DB; never `npm run dev`.
- **Prebuilt-worklet precondition** for the on-demand path: `npm run build:worklet -w @fiddle/client` (worklets are gitignored, rebuilt at client dev/build start) and `npx playwright install chromium` once.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
  ```

---

## File Structure

**Client (`packages/client/src/`):**
- `sequencer/schedule.ts` — NEW. Pure `stepDuration`, `TriggerEvent`, `resolveStepTriggers`. No `AudioContext`, no Vue, no engine objects.
- `sequencer/schedule.test.ts` — NEW. Pins `resolveStepTriggers`.
- `audio/graph.ts` — NEW (Vue-free). `engineFactories`, `sliderToLinearGain`, `buildMasterChain(ctx)`, `registerWorklets(ctx)`. Imported by `AudioEngine` and the harness.
- `audio/AudioEngine.ts` — MODIFIED. `togglePlay` calls `resolveStepTriggers`; `buildAudioState` uses `registerWorklets` + `buildMasterChain`; imports factories/gain from `graph.ts` (local copies removed).

**Audio-lab (`packages/audio-lab/`):**
- `src/tier2/harness/index.html` — NEW. Minimal Vite entry.
- `src/tier2/harness/main.ts` — NEW. `window.renderProject(project, opts)` → base64 channels.
- `src/tier2/driver.ts` — NEW. `renderProjectTier2(project, opts)` + `toMonoClip(res)`.
- `src/tier2/fixtures/sequencerFixture.ts` — NEW. `buildSequencerFixture(): Project` (source of truth).
- `src/tier2/fixtures/sequencer-check.project.json` — NEW. Serialized builder output (CLI example).
- `src/tier2/checks/sequencer.checks.ts` — NEW. Pure `expectedOnsets(project, bars, trackIndex)`.
- `src/tier2/checks/sequencer.checks.test.ts` — NEW. Unit test for `expectedOnsets` (in `npm test`).
- `src/tier2/driver.tier2.test.ts` — NEW. On-demand smoke test.
- `src/tier2/sequencer.tier2.test.ts` — NEW. On-demand onset checks.
- `vite.harness.config.ts` — NEW. Harness Vite root + publicDir.
- `vitest.tier2.config.ts` — NEW. Includes only `*.tier2.test.ts`.
- `vitest.config.ts` — MODIFIED. Exclude `**/*.tier2.test.ts`.
- `src/cli.ts` — MODIFIED. Add `render-project` command (lazy-imports the driver).
- `src/cli.test.ts` — MODIFIED. `parseCliArgs` cases for `render-project`.
- `package.json` — MODIFIED. Add `tier2` script + `@playwright/test`/`vite` devDeps.

**Root:**
- `package.json` — MODIFIED. Add `lab:tier2` script.

---

### Task 1: Pure step→trigger walk (`schedule.ts`)

**Files:**
- Create: `packages/client/src/sequencer/schedule.ts`
- Test: `packages/client/src/sequencer/schedule.test.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectTrack` from `../project`; `noteToFreq` from `../utils/notes`; `resolveChordFreqs` from `../utils/chords`.
- Produces: `stepDuration(bpm: number): number`; `interface TriggerEvent { trackIndex: number; freq: number | number[]; duration: number; time: number; velocity: number }`; `resolveStepTriggers(project: Project, absoluteStep: number, time: number): TriggerEvent[]`.

- [ ] **Step 1: Write the failing test**

`packages/client/src/sequencer/schedule.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { freshProject } from '../project';
import { stepDuration, resolveStepTriggers } from './schedule';
import { noteToFreq } from '../utils/notes';

function bareProject() {
  const p = freshProject();
  for (const t of p.tracks) t.enabled = false; // start clean
  return p;
}

describe('stepDuration', () => {
  it('is a 16th note', () => {
    expect(stepDuration(120)).toBeCloseTo((60 / 120) / 4, 12); // 0.125s
  });
});

describe('resolveStepTriggers', () => {
  it('fires a mono synth2 note as a single frequency', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'synth2'; t.engines.synth2.mode = 'mono'; t.patternLength = 16;
    t.steps[0] = { ...t.steps[0], note: 'C', octave: 4, length: 2, velocity: 0.5, muted: false };
    const evs = resolveStepTriggers(p, 0, 3.0);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ trackIndex: 0, freq: noteToFreq('C', 4), time: 3.0, velocity: 0.5 });
    expect(evs[0].duration).toBeCloseTo(2 * stepDuration(p.bpm), 12);
  });

  it('fires a poly synth2 note as a chord array', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'synth2'; t.engines.synth2.mode = 'poly';
    t.steps[0] = { ...t.steps[0], note: 'C', octave: 4, chordType: 'min', muted: false };
    const [ev] = resolveStepTriggers(p, 0, 0);
    expect(Array.isArray(ev.freq)).toBe(true);
    expect((ev.freq as number[]).length).toBe(3); // min triad
  });

  it('fires drums as freq 0, duration 0', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'kick2';
    t.steps[0] = { ...t.steps[0], note: 'C', muted: false };
    expect(resolveStepTriggers(p, 0, 1.5)[0]).toMatchObject({ trackIndex: 0, freq: 0, duration: 0, time: 1.5 });
  });

  it('skips disabled tracks, rests (note null), and muted steps', () => {
    const p = bareProject();
    p.tracks[0].engineType = 'kick2'; // disabled
    p.tracks[1].enabled = true; p.tracks[1].engineType = 'kick2';
    p.tracks[1].steps[0] = { ...p.tracks[1].steps[0], note: null };          // rest
    p.tracks[1].steps[1] = { ...p.tracks[1].steps[1], note: 'C', muted: true }; // muted
    expect(resolveStepTriggers(p, 0, 0)).toHaveLength(0);
    expect(resolveStepTriggers(p, 1, 0)).toHaveLength(0);
  });

  it('applies per-track modulo (polymeter)', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'hat2'; t.patternLength = 3;
    t.steps[0] = { ...t.steps[0], note: 'C', muted: false };
    expect(resolveStepTriggers(p, 0, 0)).toHaveLength(1); // 0 % 3 == 0
    expect(resolveStepTriggers(p, 3, 0)).toHaveLength(1); // 3 % 3 == 0
    expect(resolveStepTriggers(p, 1, 0)).toHaveLength(0); // 1 % 3 == 1 (rest)
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @fiddle/client -- schedule`
Expected: FAIL — `Cannot find module './schedule'`.

- [ ] **Step 3: Write `schedule.ts`**

`packages/client/src/sequencer/schedule.ts`:
```ts
// Pure step->trigger walk shared by live playback (AudioEngine.togglePlay) and
// the offline Tier-2 harness, so the two can never drift. No AudioContext, no
// engine objects, no Vue — resolveStepTriggers is a pure function of project
// state. Mirrors the mapping AudioEngine.onStep used to inline (per-track
// modulo, note/mute gating, poly-chord vs mono vs fire-and-forget drums).
import type { Project } from '../project';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';

export interface TriggerEvent {
  trackIndex: number;
  freq: number | number[]; // drums -> 0; synth mono -> Hz; poly -> chord Hz[]
  duration: number;        // drums -> 0; synth -> step.length * stepDuration(bpm)
  time: number;            // seconds on the ctx clock
  velocity: number;
}

/** A 16th-note step, in seconds, at the given tempo. */
export function stepDuration(bpm: number): number {
  return (60 / bpm) / 4;
}

/** Triggers due at one absolute step, for every enabled track. The live path
 *  keeps its own `state.engines[i]?` existence guard; this function only knows
 *  the project. */
export function resolveStepTriggers(project: Project, absoluteStep: number, time: number): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  const tick = stepDuration(project.bpm);
  for (let i = 0; i < project.tracks.length; i++) {
    const track = project.tracks[i];
    if (!track.enabled) continue;
    const step = track.steps[absoluteStep % track.patternLength];
    if (!step.note || step.muted) continue;

    const type = track.engineType;
    if (type === 'synth' || type === 'synth2') {
      const mode = type === 'synth' ? track.engines.synth.mode : track.engines.synth2.mode;
      const duration = step.length * tick;
      const freq = mode === 'poly'
        ? resolveChordFreqs(step.note, step.chordType || 'maj', step.octave)
        : noteToFreq(step.note, step.octave);
      events.push({ trackIndex: i, freq, duration, time, velocity: step.velocity });
    } else {
      // Drums are fire-and-forget: pitch/decay come from the engine's knobs.
      events.push({ trackIndex: i, freq: 0, duration: 0, time, velocity: step.velocity });
    }
  }
  return events;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @fiddle/client -- schedule`
Expected: PASS (all cases). Then `npm run typecheck -w @fiddle/client` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sequencer/schedule.ts packages/client/src/sequencer/schedule.test.ts
git commit -m "$(cat <<'EOF'
feat(sequencer): extract pure resolveStepTriggers walk (shared live + offline)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 2: Wire `AudioEngine.togglePlay` to the shared walk

**Files:**
- Modify: `packages/client/src/audio/AudioEngine.ts` (imports; the `onStep` closure at ~408–452)

**Interfaces:**
- Consumes: `resolveStepTriggers` from `../sequencer/schedule` (Task 1).
- Produces: no new exports; live scheduling now single-sourced.

- [ ] **Step 1: Add the import**

In `packages/client/src/audio/AudioEngine.ts`, alongside the other `../sequencer` import:
```ts
import { resolveStepTriggers } from '../sequencer/schedule';
```

- [ ] **Step 2: Replace the `onStep` body**

Replace the entire `this.sequencer.start(...)` callback (the block currently spanning `this.currentStep.value = stepIndex;` through the closing of the per-track `for` loop, AudioEngine.ts:408–452) with:
```ts
      this.sequencer.start(state.ctx, () => project.bpm, (stepIndex, time) => {
        this.currentStep.value = stepIndex;
        for (const ev of resolveStepTriggers(project, stepIndex, time)) {
          // The enabled/note/mute/freq/duration decisions now live in
          // resolveStepTriggers; only the live engine-existence guard stays here
          // (a tick racing an engine swap must not crash the audio callback).
          state.engines[ev.trackIndex]?.trigger(ev.freq, ev.duration, ev.time, ev.velocity);
        }
      });
```
The now-unused `noteToFreq` / `resolveChordFreqs` / `TRACK_POOL_SIZE` imports may remain referenced elsewhere in the file — only remove an import if `npm run typecheck -w @fiddle/client` flags it as unused.

- [ ] **Step 3: Run the client suite + typecheck**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client`
Expected: PASS. `Sequencer.test.ts` (timing loop untouched) stays green; no scheduling test regresses.

- [ ] **Step 4: Browser-verify live playback is unchanged**

```bash
npm run build:worklet -w @fiddle/client   # ensure worklets present
npm run dev:obs                            # LOCAL Docker DB — never `npm run dev`
```
Open the app, press PLAY, confirm: audible playback across a multi-track pattern (drums + a synth track), the step cursor advances, and the console is clean (favicon 404 is fine). Stop playback. This is the mandatory live-unchanged check for the scheduling rewire.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/audio/AudioEngine.ts
git commit -m "$(cat <<'EOF'
refactor(audio): togglePlay schedules via shared resolveStepTriggers

Live playback now single-sources its step->trigger mapping through the pure
walk; behavior verified unchanged in-app. Only the engine-existence guard
stays in the audio callback.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 3: Vue-free graph primitives (`audio/graph.ts`)

**Files:**
- Create: `packages/client/src/audio/graph.ts`
- Modify: `packages/client/src/audio/AudioEngine.ts` (import the primitives; use `registerWorklets` + `buildMasterChain`; remove the local `engineFactories` / `sliderToLinearGain` / inline worklet+compressor wiring)

**Interfaces:**
- Consumes: `EngineType` from `../project`; `SoundEngine` from `../engine/types`; the ten engine classes; the pulse worklet asset URL.
- Produces: `engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine>`; `sliderToLinearGain(slider: number): number`; `interface MasterChain { input: AudioNode; output: AudioNode }` + `buildMasterChain(ctx: BaseAudioContext): MasterChain`; `registerWorklets(ctx: BaseAudioContext): Promise<void>`.

- [ ] **Step 1: Write `graph.ts`**

`packages/client/src/audio/graph.ts` (move the engine imports + the two helpers out of `AudioEngine.ts`, add the two builders):
```ts
// Vue-free audio-graph primitives shared by the live AudioEngine and the
// offline Tier-2 harness. Kept out of AudioEngine.ts (which imports Vue) so
// the audio-lab harness can import these without pulling Vue into its bundle.
import type { EngineType } from '../project';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import { Synth2Engine } from '../engine/Synth2Engine';
import { Kick2Engine } from '../engine/Kick2Engine';
import { Snare2Engine } from '../engine/Snare2Engine';
import { Hat2Engine } from '../engine/Hat2Engine';
import { Clap2Engine } from '../engine/Clap2Engine';

// Pulse worklet — a Vite module-graph asset (emitted via new URL(...,
// import.meta.url)). Path is identical from audio/ as it was in AudioEngine.ts.
const pulseWorkletUrl = new URL('../engine/worklets/pulse-processor.js', import.meta.url).href;
// The five *2 worklets — esbuild-bundled static assets under public/worklets.
const synth2WorkletUrl = '/worklets/synth2-processor.js';
const kick2WorkletUrl  = '/worklets/kick2-processor.js';
const snare2WorkletUrl = '/worklets/snare2-processor.js';
const hat2WorkletUrl   = '/worklets/hat2-processor.js';
const clap2WorkletUrl  = '/worklets/clap2-processor.js';

export const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth:  (ctx, dest) => new SynthEngine(ctx, dest),
  kick:   (ctx, dest) => new KickEngine(ctx, dest),
  hat:    (ctx, dest) => new HatEngine(ctx, dest),
  snare:  (ctx, dest) => new SnareEngine(ctx, dest),
  clap:   (ctx, dest) => new ClapEngine(ctx, dest),
  synth2: (ctx, dest) => new Synth2Engine(ctx, dest),
  kick2:  (ctx, dest) => new Kick2Engine(ctx, dest),
  snare2: (ctx, dest) => new Snare2Engine(ctx, dest),
  hat2:   (ctx, dest) => new Hat2Engine(ctx, dest),
  clap2:  (ctx, dest) => new Clap2Engine(ctx, dest),
};

// Mixer slider position 0..1 (perceptual) -> linear gain via -54..+6 dB. 0 is
// hard silence. Display formula lives in Knob.vue case 'db' — keep in sync.
export function sliderToLinearGain(slider: number): number {
  if (slider <= 0) return 0;
  const db = -54 + slider * 60;
  return Math.pow(10, db / 20);
}

export interface MasterChain { input: AudioNode; output: AudioNode }

/** Compressor -> masterGain, wired. `input` is the compressor (connect track
 *  gains here); `output` is the masterGain (connect to ctx.destination). */
export function buildMasterChain(ctx: BaseAudioContext): MasterChain {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-12, ctx.currentTime);
  compressor.knee.setValueAtTime(30, ctx.currentTime);
  compressor.ratio.setValueAtTime(12, ctx.currentTime);
  compressor.attack.setValueAtTime(0.003, ctx.currentTime);
  compressor.release.setValueAtTime(0.25, ctx.currentTime);
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.6, ctx.currentTime);
  compressor.connect(masterGain);
  return { input: compressor, output: masterGain };
}

/** Register every worklet module the engines need, in the app's order. Both
 *  the live AudioContext and the harness OfflineAudioContext call this. */
export async function registerWorklets(ctx: BaseAudioContext): Promise<void> {
  await ctx.audioWorklet.addModule(pulseWorkletUrl);
  await ctx.audioWorklet.addModule(synth2WorkletUrl);
  await ctx.audioWorklet.addModule(kick2WorkletUrl);
  await ctx.audioWorklet.addModule(snare2WorkletUrl);
  await ctx.audioWorklet.addModule(hat2WorkletUrl);
  await ctx.audioWorklet.addModule(clap2WorkletUrl);
}
```

- [ ] **Step 2: Rewire `AudioEngine.ts` to use `graph.ts`**

In `AudioEngine.ts`:
1. Remove the ten engine-class imports, the six worklet-URL consts, the `engineFactories` const, and the `sliderToLinearGain` function (now in `graph.ts`). Keep `SoundEngine` if still referenced by types; keep the `ENGINE_SWAP_FADE_SECONDS` const.
2. Add: `import { engineFactories, sliderToLinearGain, buildMasterChain, registerWorklets } from './graph';`
3. In `buildAudioState`, replace the six `await ctx.audioWorklet.addModule(...)` lines with:
   ```ts
   await registerWorklets(ctx);
   ```
4. Replace the compressor+masterGain construction block (`const compressor = ctx.createDynamicsCompressor(); … masterGain.connect(ctx.destination);`) with:
   ```ts
   const master = buildMasterChain(ctx);
   master.output.connect(ctx.destination);
   ```
5. In the per-track loop, change `g.connect(compressor);` to `g.connect(master.input);`.

- [ ] **Step 3: Run the client suite + typecheck**

Run: `npm run test -w @fiddle/client && npm run typecheck -w @fiddle/client`
Expected: PASS, clean. (If typecheck flags an unused import in `AudioEngine.ts`, delete it.)

- [ ] **Step 4: Browser-verify the graph still builds and plays**

```bash
npm run build:worklet -w @fiddle/client
npm run dev:obs
```
Open the app, PLAY: all engine types (v1 synth, a `*2` drum) produce sound, mixer volume/mute/solo behave, console clean. This confirms `registerWorklets` + `buildMasterChain` reproduce the graph exactly.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/audio/graph.ts packages/client/src/audio/AudioEngine.ts
git commit -m "$(cat <<'EOF'
refactor(audio): extract Vue-free graph primitives into audio/graph.ts

engineFactories, sliderToLinearGain, buildMasterChain, registerWorklets now
live in a Vue-free module the Tier-2 harness can import. AudioEngine builds
its graph from them; behavior verified unchanged in-app.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 4: Harness page + driver + on-demand smoke test

**Files:**
- Create: `packages/audio-lab/src/tier2/harness/index.html`, `packages/audio-lab/src/tier2/harness/main.ts`
- Create: `packages/audio-lab/vite.harness.config.ts`
- Create: `packages/audio-lab/src/tier2/driver.ts`
- Create: `packages/audio-lab/src/tier2/driver.tier2.test.ts`
- Create: `packages/audio-lab/vitest.tier2.config.ts`
- Modify: `packages/audio-lab/vitest.config.ts` (exclude `*.tier2.test.ts`)
- Modify: `packages/audio-lab/package.json` (add `tier2` script + devDeps)
- Modify: root `package.json` (add `lab:tier2`)

**Interfaces:**
- Consumes: `resolveStepTriggers`, `stepDuration` from `@fiddle/client/src/sequencer/schedule`; `engineFactories`, `sliderToLinearGain`, `buildMasterChain`, `registerWorklets` from `@fiddle/client/src/audio/graph`; `Project` from `@fiddle/shared`; `freshProject` from `@fiddle/shared`; `analyzeEnvelope` from `../analyze/envelope`; `AudioClip` from `../types`.
- Produces: `renderProjectTier2(project: Project, opts: { bars: number; soloTrack?: number }): Promise<{ channels: Float32Array[]; sampleRate: number }>`; `toMonoClip(res): AudioClip`.

- [ ] **Step 1: Harness page**

`packages/audio-lab/src/tier2/harness/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>tier2 harness</title></head>
  <body><script type="module" src="./main.ts"></script></body>
</html>
```

`packages/audio-lab/src/tier2/harness/main.ts`:
```ts
import type { Project } from '@fiddle/shared';
import { resolveStepTriggers, stepDuration } from '@fiddle/client/src/sequencer/schedule';
import { engineFactories, sliderToLinearGain, buildMasterChain, registerWorklets } from '@fiddle/client/src/audio/graph';

const SR = 48000;
const TAIL_SECONDS = 2.0; // let the last step's release/tail finish

function f32ToBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  const CHUNK = 0x8000; // chunk so String.fromCharCode doesn't blow the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Faithful to AudioEngine.updateMixerGains, plus the CLI --solo override.
function trackGain(project: Project, i: number, soloTrack?: number): number {
  const track = project.tracks[i];
  if (!track.enabled) return 0;
  if (soloTrack !== undefined) return i === soloTrack ? sliderToLinearGain(track.mixer.volume) : 0;
  const anySoloed = project.tracks.some((t) => t.enabled && t.mixer.soloed);
  const audible = anySoloed ? (track.mixer.soloed && !track.mixer.muted) : !track.mixer.muted;
  return audible ? sliderToLinearGain(track.mixer.volume) : 0;
}

async function renderProject(project: Project, opts: { bars: number; soloTrack?: number }) {
  const bpm = project.bpm;
  const totalSteps = opts.bars * 16;
  const dur = totalSteps * stepDuration(bpm) + TAIL_SECONDS;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  await registerWorklets(ctx);

  const master = buildMasterChain(ctx);
  master.output.connect(ctx.destination);

  const engines: (ReturnType<(typeof engineFactories)[keyof typeof engineFactories]> | undefined)[] =
    new Array(project.tracks.length).fill(undefined);
  for (let i = 0; i < project.tracks.length; i++) {
    const track = project.tracks[i];
    const g = ctx.createGain();
    g.gain.value = trackGain(project, i, opts.soloTrack);
    g.connect(master.input);
    if (!track.enabled) continue;
    // OfflineAudioContext is a BaseAudioContext; the engine ctors only use
    // BaseAudioContext members, so the cast is runtime-safe.
    const engine = engineFactories[track.engineType](ctx as unknown as AudioContext, g);
    // NB: synth2 tempo-synced LFO/env/glide derivation lives in AudioEngine and
    // is a sub-project C concern; here stored (free) values are applied as-is.
    engine.applyParams(track.engines[track.engineType] as Record<string, unknown>);
    engines[i] = engine;
  }

  for (let k = 0; k < totalSteps; k++) {
    const t = k * stepDuration(bpm);
    for (const ev of resolveStepTriggers(project, k, t)) {
      engines[ev.trackIndex]?.trigger(ev.freq, ev.duration, ev.time, ev.velocity);
    }
  }

  const buf = await ctx.startRendering();
  return {
    channels: [f32ToBase64(buf.getChannelData(0)), f32ToBase64(buf.getChannelData(1))],
    sampleRate: SR,
  };
}

(window as unknown as { renderProject: typeof renderProject }).renderProject = renderProject;
```

- [ ] **Step 2: Harness Vite config**

`packages/audio-lab/vite.harness.config.ts`:
```ts
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// root = the harness page; publicDir = client's public/ so /worklets/* resolve
// to the prebuilt worklet bundles. fs.allow the repo root so deep imports into
// @fiddle/client/src/** and @fiddle/shared/src/** are served in dev.
export default defineConfig({
  root: abs('./src/tier2/harness'),
  publicDir: abs('../client/public'),
  server: {
    port: 5190,
    strictPort: false, // auto-bump if busy — never collide with the user's :5173
    fs: { allow: [abs('../..')] },
  },
});
```

- [ ] **Step 3: Driver + smoke test**

`packages/audio-lab/src/tier2/driver.ts`:
```ts
import { chromium, type Browser } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type { Project } from '@fiddle/shared';
import type { AudioClip } from '../types';

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const WORKLET_DIR = abs('../../../client/public/worklets');
const REQUIRED = ['synth2', 'kick2', 'snare2', 'hat2', 'clap2'].map((n) => `${n}-processor.js`);

export interface Tier2Result { channels: Float32Array[]; sampleRate: number }

export async function renderProjectTier2(
  project: Project,
  opts: { bars: number; soloTrack?: number },
): Promise<Tier2Result> {
  for (const w of REQUIRED) {
    try {
      await access(join(WORKLET_DIR, w));
    } catch {
      throw new Error(`Tier-2: missing worklet ${w}. Run: npm run build:worklet -w @fiddle/client`);
    }
  }

  const server = await createServer({ configFile: abs('../../vite.harness.config.ts') });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Tier-2: harness server did not resolve a URL');

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => typeof (window as { renderProject?: unknown }).renderProject === 'function');
    const result = (await page.evaluate(
      ([p, o]) => (window as unknown as { renderProject: (p: unknown, o: unknown) => Promise<{ channels: string[]; sampleRate: number }> }).renderProject(p, o),
      [project, opts] as const,
    )) as { channels: string[]; sampleRate: number };

    const channels = result.channels.map((b64) => {
      const buf = Buffer.from(b64, 'base64');
      return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    });
    return { channels, sampleRate: result.sampleRate };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/** Downmix to the lab's mono AudioClip for the existing analysis core. */
export function toMonoClip(res: Tier2Result): AudioClip {
  const [l, r] = res.channels;
  const mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = r ? (l[i] + r[i]) * 0.5 : l[i];
  return { samples: mono, sampleRate: res.sampleRate };
}
```

`packages/audio-lab/src/tier2/driver.tier2.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { renderProjectTier2, toMonoClip } from './driver';
import { analyzeEnvelope } from '../analyze/envelope';

describe('tier2 driver (browser)', () => {
  it('renders a kick pattern to non-silent audio with onsets', async () => {
    const p = freshProject();
    for (let i = 1; i < p.tracks.length; i++) p.tracks[i].enabled = false;
    p.tracks[0].enabled = true;
    p.tracks[0].engineType = 'kick2';
    for (const s of [0, 4, 8, 12]) p.tracks[0].steps[s] = { ...p.tracks[0].steps[s], note: 'C', muted: false };

    const res = await renderProjectTier2(p, { bars: 1 });
    const clip = toMonoClip(res);

    expect(clip.samples.length).toBeGreaterThan(0);
    const env = analyzeEnvelope(clip);
    expect(Number.isFinite(env.peakDb)).toBe(true);
    expect(env.peakDb).toBeGreaterThan(-40);
    expect(env.onsets.length).toBe(4);
  }, 120_000);
});
```

- [ ] **Step 4: Vitest tier2 config + default exclude**

`packages/audio-lab/vitest.tier2.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

// Browser-launching, on-demand tests only. Never part of `npm test`.
export default defineConfig({
  test: {
    include: ['src/tier2/**/*.tier2.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false, // one browser at a time
  },
});
```

Modify `packages/audio-lab/vitest.config.ts` exclude array to also skip the tier2 tests:
```ts
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/src/audit/audit.test.ts', '**/*.tier2.test.ts'],
  },
});
```

- [ ] **Step 5: Scripts + devDeps**

In `packages/audio-lab/package.json` add to `scripts`:
```json
"tier2": "vitest run --config vitest.tier2.config.ts"
```
and to `devDependencies`:
```json
"@playwright/test": "^1.49.1",
"vite": "^5.0.0"
```
In root `package.json` add to `scripts`:
```json
"lab:tier2": "npm run tier2 -w @fiddle/audio-lab"
```

- [ ] **Step 6: Verify default gate is unaffected, then run the smoke test**

Run: `npm run test -w @fiddle/audio-lab` → PASS, and confirm it does NOT run `driver.tier2.test.ts` (no browser launched).
Run: `npm run typecheck -w @fiddle/audio-lab` → clean.
Prereqs, then the on-demand smoke:
```bash
npm run build:worklet -w @fiddle/client   # worklets present
npx playwright install chromium           # once
npm run lab:tier2                          # runs driver.tier2.test.ts
```
Expected: the smoke test PASSES — 4 onsets, peak > −40 dB, finite. If chromium is missing the driver’s error names the install command.

- [ ] **Step 7: Commit**

```bash
git add packages/audio-lab/src/tier2/harness packages/audio-lab/vite.harness.config.ts \
        packages/audio-lab/src/tier2/driver.ts packages/audio-lab/src/tier2/driver.tier2.test.ts \
        packages/audio-lab/vitest.tier2.config.ts packages/audio-lab/vitest.config.ts \
        packages/audio-lab/package.json package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(audio-lab): Tier-2 harness + Playwright driver (OfflineAudioContext render)

A Vite harness page renders a project through the real graph in headless
chromium; the driver runs its own server + browser (never the user's dev
servers) and hands mono samples to the existing analysis core. On-demand
smoke test behind `npm run lab:tier2`, out of the merge gate.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 5: Fixture + `render-project` CLI

**Files:**
- Create: `packages/audio-lab/src/tier2/fixtures/sequencerFixture.ts`
- Create: `packages/audio-lab/src/tier2/fixtures/sequencer-check.project.json`
- Create: `packages/audio-lab/src/tier2/fixtures/sequencerFixture.test.ts`
- Modify: `packages/audio-lab/src/cli.ts` (add `render-project`)
- Modify: `packages/audio-lab/src/cli.test.ts` (`parseCliArgs` cases)

**Interfaces:**
- Consumes: `freshProject` + `ProjectSchema` + `normalizeProject` + `Project` from `@fiddle/shared`; `renderProjectTier2`, `toMonoClip` from `./tier2/driver` (lazy-imported in `runCli`); `writeRunDir`, `defaultRunDir` from `./report/report`.
- Produces: `buildSequencerFixture(): Project`; CLI command `render-project <file.json> [--bars N] [--solo I] [--label NAME] [--out DIR]`.

- [ ] **Step 1: Fixture builder + validation test**

`packages/audio-lab/src/tier2/fixtures/sequencerFixture.ts`:
```ts
import { freshProject, type Project } from '@fiddle/shared';

// A deterministic-structure project for the sequencer-correctness checks.
// Three enabled tracks; track 2 is polymeter (patternLength 12) so it wraps
// against the 16-step bar. Drum engines only → sharp, unambiguous onsets.
export function buildSequencerFixture(): Project {
  const p = freshProject();
  p.bpm = 120;
  for (let i = 0; i < p.tracks.length; i++) p.tracks[i].enabled = i < 3;

  const put = (track: number, step: number) => {
    p.tracks[track].steps[step] = { ...p.tracks[track].steps[step], note: 'C', muted: false };
  };

  // Track 0 — kick2, four-on-the-floor (steps 0,4,8,12), patternLength 16.
  p.tracks[0].engineType = 'kick2';
  p.tracks[0].patternLength = 16;
  for (const s of [0, 4, 8, 12]) put(0, s);

  // Track 1 — clap2, backbeat (steps 4,12), patternLength 16.
  p.tracks[1].engineType = 'clap2';
  p.tracks[1].patternLength = 16;
  for (const s of [4, 12]) put(1, s);

  // Track 2 — hat2, single hit at local step 0, patternLength 12 (polymeter):
  // fires at absolute steps 0,12,24,36,... .
  p.tracks[2].engineType = 'hat2';
  p.tracks[2].patternLength = 12;
  put(2, 0);

  return p;
}
```

`packages/audio-lab/src/tier2/fixtures/sequencerFixture.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ProjectSchema } from '@fiddle/shared';
import { buildSequencerFixture } from './sequencerFixture';

describe('sequencer fixture', () => {
  it('is a schema-valid project', () => {
    expect(() => ProjectSchema.parse(buildSequencerFixture())).not.toThrow();
  });

  it('the committed JSON matches the builder (no drift)', async () => {
    const json = await readFile(fileURLToPath(new URL('./sequencer-check.project.json', import.meta.url)), 'utf8');
    expect(JSON.parse(json)).toEqual(buildSequencerFixture());
  });
});
```

- [ ] **Step 2: Generate the committed JSON, then run the test**

Generate the artifact from the single source of truth (run from `packages/audio-lab`):
```bash
npx tsx -e "import('./src/tier2/fixtures/sequencerFixture.ts').then(async m => { const { writeFile } = await import('node:fs/promises'); await writeFile('src/tier2/fixtures/sequencer-check.project.json', JSON.stringify(m.buildSequencerFixture(), null, 2) + '\n'); })"
```
Run: `npm run test -w @fiddle/audio-lab -- sequencerFixture`
Expected: PASS — schema-valid and the JSON deep-equals the builder.

- [ ] **Step 3: Add the `render-project` command to the CLI**

In `packages/audio-lab/src/cli.ts`:

Extend the union:
```ts
export type CliCommand =
  | { kind: 'render-engine'; spec: EngineRenderSpec; label: string; out?: string }
  | { kind: 'analyze'; file: string; label: string; out?: string }
  | { kind: 'compare'; dirA: string; dirB: string }
  | { kind: 'render-project'; file: string; bars: number; soloTrack?: number; label: string; out?: string };
```

Route it in `parseCliArgs` (add before the final `throw`):
```ts
  if (command === 'render-project') return parseRenderProject(rest);
```

Add the parser (mirrors `parseAnalyze`; `--bars`/`--solo` are single-value flags handled by `collectFlags`):
```ts
function parseRenderProject(args: string[]): CliCommand {
  const bag = collectFlags(args);
  const file = bag.positional[0];
  if (!file) throw new CliUsageError(USAGE);
  const base = file.split('/').pop()!.replace(/\.json$/i, '');
  const bars = bag.single.has('--bars') ? Number(bag.single.get('--bars')) : 2;
  const soloTrack = bag.single.has('--solo') ? Number(bag.single.get('--solo')) : undefined;
  return {
    kind: 'render-project',
    file,
    bars,
    soloTrack,
    label: bag.single.get('--label') ?? base,
    out: bag.single.get('--out'),
  };
}
```

Handle it in `runCli` (lazy-import the driver so `npm test`'s `cli.test.ts` never loads Playwright/Vite):
```ts
  if (cmd.kind === 'render-project') {
    const { normalizeProject } = await import('@fiddle/shared');
    const { renderProjectTier2, toMonoClip } = await import('./tier2/driver');
    const raw = JSON.parse(await readFile(cmd.file, 'utf8'));
    const project = normalizeProject(raw);
    const res = await renderProjectTier2(project, { bars: cmd.bars, soloTrack: cmd.soloTrack });
    const clip = toMonoClip(res);
    const dir = cmd.out ?? defaultRunDir(cmd.label);
    const report = await writeRunDir({ dir, spec: { file: cmd.file, bars: cmd.bars, soloTrack: cmd.soloTrack }, clip });
    return { dir, summaryText: summaryText(report) };
  }
```

Add the usage line to `USAGE` (after the `render-engine` line):
```
  npm run lab -- render-project <file.json> [--bars N] [--solo TRACK] [--label NAME] [--out DIR]
```

- [ ] **Step 4: `parseCliArgs` tests + run**

Add to `packages/audio-lab/src/cli.test.ts`:
```ts
import { parseCliArgs } from './cli';
// ...
it('parses render-project with defaults', () => {
  const c = parseCliArgs(['render-project', 'foo/bar.json']);
  expect(c).toMatchObject({ kind: 'render-project', file: 'foo/bar.json', bars: 2, label: 'bar' });
});
it('parses render-project flags', () => {
  const c = parseCliArgs(['render-project', 'p.json', '--bars', '4', '--solo', '2', '--label', 'x']);
  expect(c).toMatchObject({ kind: 'render-project', bars: 4, soloTrack: 2, label: 'x' });
});
```
Run: `npm run test -w @fiddle/audio-lab -- cli` → PASS (still no browser stack loaded). `npm run typecheck -w @fiddle/audio-lab` → clean.

- [ ] **Step 5: Manually exercise the full command (on-demand)**

```bash
npm run build:worklet -w @fiddle/client
npm run lab -- render-project packages/audio-lab/src/tier2/fixtures/sequencer-check.project.json --bars 3 --label fixture-mix
```
Expected: prints a `run dir:` path and a summary JSON with `onsets`, `peakDb` finite and > −40. Optionally `--solo 2` to isolate the polymeter hat track. (Run dirs are gitignored — do not stage.)

- [ ] **Step 6: Commit**

```bash
git add packages/audio-lab/src/tier2/fixtures packages/audio-lab/src/cli.ts packages/audio-lab/src/cli.test.ts
git commit -m "$(cat <<'EOF'
feat(audio-lab): render-project CLI + sequencer fixture

`npm run lab -- render-project <file.json>` renders a whole project (or a
--solo track) through the Tier-2 harness into a normal run dir. Committed
fixture (incl. a polymeter track) is the builder's serialized output, pinned
against drift.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

### Task 6: Sequencer-correctness checks

**Files:**
- Create: `packages/audio-lab/src/tier2/checks/sequencer.checks.ts`
- Create: `packages/audio-lab/src/tier2/checks/sequencer.checks.test.ts`
- Create: `packages/audio-lab/src/tier2/sequencer.tier2.test.ts`

**Interfaces:**
- Consumes: `stepDuration` from `@fiddle/client/src/sequencer/schedule`; `Project` from `@fiddle/shared`; `buildSequencerFixture` from `./fixtures/sequencerFixture`; `renderProjectTier2`, `toMonoClip` from `./driver`; `analyzeEnvelope` from `../analyze/envelope`.
- Produces: `expectedOnsets(project: Project, bars: number, trackIndex: number): number[]`.

- [ ] **Step 1: Pure `expectedOnsets` + unit test**

`packages/audio-lab/src/tier2/checks/sequencer.checks.ts`:
```ts
import type { Project } from '@fiddle/shared';
import { stepDuration } from '@fiddle/client/src/sequencer/schedule';

// Grid times (seconds) at which a solo render of `trackIndex` should show an
// onset: every firing (note && !muted) step in the render window, per-track
// modulo applied. Pure — the ground truth the browser render is checked against.
export function expectedOnsets(project: Project, bars: number, trackIndex: number): number[] {
  const track = project.tracks[trackIndex];
  const tick = stepDuration(project.bpm);
  const totalSteps = bars * 16;
  const times: number[] = [];
  for (let k = 0; k < totalSteps; k++) {
    const step = track.steps[k % track.patternLength];
    if (step.note && !step.muted) times.push(k * tick);
  }
  return times;
}
```

`packages/audio-lab/src/tier2/checks/sequencer.checks.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSequencerFixture } from '../fixtures/sequencerFixture';
import { expectedOnsets } from './sequencer.checks';

describe('expectedOnsets', () => {
  const p = buildSequencerFixture(); // bpm 120 → tick 0.125s
  it('four-on-the-floor over 2 bars (track 0)', () => {
    expect(expectedOnsets(p, 2, 0)).toEqual([0, 4, 8, 12, 16, 20, 24, 28].map((k) => k * 0.125));
  });
  it('polymeter track wraps at patternLength 12 (track 2), 3 bars', () => {
    expect(expectedOnsets(p, 3, 2)).toEqual([0, 12, 24, 36].map((k) => k * 0.125));
  });
});
```

Run: `npm run test -w @fiddle/audio-lab -- sequencer.checks` → PASS.

- [ ] **Step 2: On-demand onset checks (browser)**

`packages/audio-lab/src/tier2/sequencer.tier2.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSequencerFixture } from './fixtures/sequencerFixture';
import { expectedOnsets } from './checks/sequencer.checks';
import { renderProjectTier2, toMonoClip } from './driver';
import { analyzeEnvelope } from '../analyze/envelope';

const BARS = 3;
const TOL = 0.02; // onset detected within ~1–3 hops of the trigger (attack ramp)

describe('sequencer correctness (browser)', () => {
  for (const trackIndex of [0, 1, 2]) {
    it(`track ${trackIndex}: onsets match the step grid`, async () => {
      const project = buildSequencerFixture();
      const expected = expectedOnsets(project, BARS, trackIndex);
      const res = await renderProjectTier2(project, { bars: BARS, soloTrack: trackIndex });
      const { onsets } = analyzeEnvelope(toMonoClip(res));

      // (1) onset count == firing steps in the window
      expect(onsets.length).toBe(expected.length);
      // (2) each detected onset aligns to its grid time within tolerance
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(onsets[i] - expected[i])).toBeLessThan(TOL);
      }
    }, 120_000);
  }

  it('track 2 is polymeter: exactly 4 onsets at 0,12,24,36 over 3 bars', async () => {
    const project = buildSequencerFixture();
    const res = await renderProjectTier2(project, { bars: BARS, soloTrack: 2 });
    const { onsets } = analyzeEnvelope(toMonoClip(res));
    expect(onsets.length).toBe(4);
    [0, 12, 24, 36].forEach((k, i) => expect(Math.abs(onsets[i] - k * 0.125)).toBeLessThan(TOL));
  }, 120_000);
});
```

- [ ] **Step 3: Run the full on-demand suite**

```bash
npm run build:worklet -w @fiddle/client
npm run lab:tier2   # driver smoke + sequencer checks
```
Expected: all `*.tier2.test.ts` PASS. If any onset delta approaches `TOL`, print the actual deltas and, only if they are consistently tiny, tighten `TOL` toward the observed max + margin; if a delta exceeds `TOL`, that is a real finding — do not loosen the tolerance to hide it; investigate the schedule/render.

- [ ] **Step 4: Confirm the default gate still excludes browser tests**

Run: `npm run test -w @fiddle/audio-lab` → PASS and launches no browser (the `expectedOnsets` and fixture unit tests run; the `*.tier2.test.ts` files do not).
Run the whole repo gate: `npm run typecheck && npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-lab/src/tier2/checks packages/audio-lab/src/tier2/sequencer.tier2.test.ts
git commit -m "$(cat <<'EOF'
test(audio-lab): Tier-2 sequencer-correctness checks (onset grid + polymeter)

Solo-renders each fixture track and asserts detected onsets match the pure
expectedOnsets grid — count, alignment (±20ms), and polymeter wrapping. Runs
on demand via `npm run lab:tier2`.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Whole-project offline render through the real graph → Tasks 3+4 (graph primitives + harness). ✓
- Per-track solo renders (`--solo`) → Task 4 `trackGain` override + Task 5 CLI. ✓
- Single-sourced step→trigger scheduling + live-unchanged proof → Tasks 1+2. ✓
- Sequencer-correctness check set (count / alignment / polymeter) → Task 6. ✓
- `render-project` CLI writing a normal run dir → Task 5. ✓
- Driver never touches the user's dev servers → Task 4 (own port `strictPort:false`, own browser, `finally` teardown). ✓
- No new analysis code (reuse analysis core + run-dir writer) → Tasks 4/5/6 use `analyzeEnvelope`, `writeRunDir`. ✓
- No bit-exact / tolerance-based → Task 6 `TOL`, structural onset asserts. ✓
- On-demand out of the merge gate → Task 4 `*.tier2.test.ts` suffix + config split + Task 6 Step 4 gate check. ✓
- Vue-free `graph.ts` → Task 3. ✓
- Documented synth2-sync limitation (deferred to C) → Task 4 `main.ts` comment. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step carries complete code. `TOL = 0.02` is a concrete starting value with an explicit calibration/finding rule (Task 6 Step 3).

**3. Type consistency:** `TriggerEvent`/`resolveStepTriggers`/`stepDuration` (Task 1) are consumed with identical signatures in Tasks 2, 4, 6. `renderProjectTier2(project, {bars, soloTrack})` / `toMonoClip` (Task 4) match their uses in Tasks 5, 6. `buildSequencerFixture(): Project` (Task 5) matches Task 6. `expectedOnsets(project, bars, trackIndex)` (Task 6) matches its test. `engineFactories`/`sliderToLinearGain`/`buildMasterChain`/`registerWorklets` (Task 3) match `AudioEngine` rewire and harness `main.ts`.
