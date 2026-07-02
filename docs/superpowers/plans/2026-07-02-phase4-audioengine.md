# Phase 4 — Extract `AudioEngine` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the audio cluster (AudioContext + per-track engines + Sequencer + transport) out of `composables/useSynth.ts` into a single `AudioEngine` service with an idempotent `dispose()`, facade-preserving so no consumer file changes.

**Architecture:** A **verbatim relocation**, not a rewrite (mirrors Phase 3's `SyncSession`). `useSynth` constructs one eager module-scope `AudioEngine` singleton and rewrites its audio exports as thin delegators. The shared pure helper `diffParams` moves to a neutral leaf module both units import (avoiding a `useSynth`↔`AudioEngine` cycle). Behaviour is byte-identical modulo two called-out consequences (below).

**Tech Stack:** TypeScript, Vue 3 reactivity (`ref`/`reactive`/`computed`/`shallowRef`/`watch`/`effectScope`), Web Audio API, Vitest.

## Global Constraints

- **Verbatim relocation.** Reproduce relocated bodies byte-for-byte; do not paraphrase, "improve," or reorder logic. Fidelity to the current `useSynth.ts` source is the priority.
- **Facade-preserving.** No consumer file changes. `git diff --stat main` for the whole branch must show ONLY: new `packages/client/src/audio/AudioEngine.ts`, new `packages/client/src/audio/AudioEngine.test.ts`, new `packages/client/src/project/paramDiff.ts`, new `packages/client/src/project/paramDiff.test.ts`, modified `packages/client/src/composables/useSynth.ts`.
- **`AudioEngine` imports nothing from `sync/` or `composables/useSynth`** (one-directional, cycle-free edge).
- **Two deliberate, called-out consequences** (not "byte-identical" but intended):
  1. `currentStep` moves from a per-`useSynth()`-call ref to a single `AudioEngine`-owned ref (only `StudioView` reads it; no visible change).
  2. `AudioEngine.dispose()` calls `this.sequencer.stop()` (current `disposeSynth` does not; `disposeSynth` is test-only in production, so this is inert there and only tightens teardown — the whole point of the redesign).
- **No `.vue` mounts in new unit tests.**
- **Never work on main / never `git add -A`.** Stage only the named files. Never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`, `studio-rack.png`.
- **Commit trailer** (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir
  ```
- **Test commands:** focused `npx vitest run <path>` (from `packages/client`); full client suite `cd packages/client && npm test`; typecheck `npm run typecheck` (repo root, all 3 workspaces).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/client/src/project/paramDiff.ts` (new) | Pure `diffParams(newVal, oldVal)` — the changed-key diff. Neutral leaf imported by both `AudioEngine` and `useSynth`'s sync emitters. |
| `packages/client/src/project/paramDiff.test.ts` (new) | Unit tests for `diffParams`. |
| `packages/client/src/audio/AudioEngine.ts` (new) | The `AudioEngine` class: owns ctx/engines/gains/analysers/scope/sequencer/transport; `ensureAudio()`, `togglePlay()`, `stopPlayback()`, `dispose()`. Exports `AudioState`, `AudioEngineDeps`. |
| `packages/client/src/audio/AudioEngine.test.ts` (new) | Unit tests for `AudioEngine` over a `MockAudioContext`. |
| `packages/client/src/composables/useSynth.ts` (modify) | Task 1: import `diffParams` from `paramDiff`. Task 2: construct the `AudioEngine` singleton, delete the relocated audio code, rewrite delegators. |

---

## Task 1: `paramDiff` module + `AudioEngine` class (dead code)

Builds the neutral `diffParams` module and the full `AudioEngine` class **without wiring it into `useSynth`'s runtime** (constructed nowhere yet). The only `useSynth` change in this task is swapping its local `diffParams` definition for an import — behaviour-identical, keeps the tree green and DRY.

**Files:**
- Create: `packages/client/src/project/paramDiff.ts`
- Test: `packages/client/src/project/paramDiff.test.ts`
- Create: `packages/client/src/audio/AudioEngine.ts`
- Test: `packages/client/src/audio/AudioEngine.test.ts`
- Modify: `packages/client/src/composables/useSynth.ts` (replace local `diffParams` with import)

**Interfaces:**
- Produces (consumed by Task 2 and by `useSynth`'s sync emitters):
  - `export function diffParams<T extends Record<string, unknown>>(newVal: T, oldVal: T | undefined): Partial<T> | null`
  - `export interface AudioState { ctx: AudioContext; trackAnalysers: AnalyserNode[]; trackGains: GainNode[]; engines: (SoundEngine | undefined)[]; pendingDisposes: Map<ReturnType<typeof setTimeout>, SoundEngine>; scope: EffectScope; }`
  - `export interface AudioEngineDeps { project: Project; }`
  - `export class AudioEngine` with: `readonly sequencer`, `readonly currentStep: Ref<number>`, `readonly trackAnalysers: ComputedRef<AnalyserNode[] | null>`, `readonly trackGains: ComputedRef<GainNode[] | null>`, `ensureAudio(): Promise<AudioState>`, `togglePlay(): Promise<void>`, `stopPlayback(): void`, `dispose(): void`.

- [ ] **Step 1: Create `paramDiff.ts`** (verbatim move of `useSynth.ts:104-126`)

`packages/client/src/project/paramDiff.ts`:
```ts
// Pure param-diff helper, shared by AudioEngine (its slice watcher) and useSynth's
// bulk sync emitters (syncStepWindowDiff / syncWholeProjectDiff / syncEngineParamsDiff).
// Lives in its own leaf module because both units need it — putting it in either
// would create a useSynth <-> AudioEngine import cycle. Relocated verbatim from
// useSynth.ts (Phase 4).

// Returns the subset of `newVal` keys whose values differ from `oldVal`, or
// null if nothing changed. Used to feed engine.applyParams() the minimum set
// of writes per knob turn instead of the full slice (was 13 writes/knob for
// the synth; now typically 1).
export function diffParams<T extends Record<string, unknown>>(
  newVal: T,
  oldVal: T | undefined
): Partial<T> | null {
  if (!oldVal) return null;
  const changed: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(newVal) as Array<keyof T>) {
    const a = newVal[key];
    const b = oldVal[key];
    if (a === b) continue;
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    }
    changed[key] = a as T[keyof T];
    any = true;
  }
  return any ? changed : null;
}
```

- [ ] **Step 2: Write `paramDiff.test.ts`**

`packages/client/src/project/paramDiff.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { diffParams } from './paramDiff';

describe('diffParams', () => {
  it('returns null when there is no oldVal (first application)', () => {
    expect(diffParams({ a: 1 }, undefined)).toBeNull();
  });

  it('returns null when nothing changed', () => {
    expect(diffParams({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeNull();
  });

  it('returns only the changed scalar keys', () => {
    expect(diffParams({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, c: 3 })).toEqual({ b: 2 });
  });

  it('treats deep-equal nested objects as unchanged (JSON compare)', () => {
    expect(diffParams({ env: { a: 1, d: 2 } }, { env: { a: 1, d: 2 } })).toBeNull();
  });

  it('returns the whole nested object when a nested leaf changed', () => {
    const out = diffParams({ env: { a: 1, d: 2 } }, { env: { a: 1, d: 9 } });
    expect(out).toEqual({ env: { a: 1, d: 2 } });
  });
});
```

- [ ] **Step 3: Run the paramDiff test — expect PASS**

Run: `cd packages/client && npx vitest run src/project/paramDiff.test.ts`
Expected: 5 passed.

- [ ] **Step 4: Point `useSynth` at the new module** (remove its local `diffParams`)

In `packages/client/src/composables/useSynth.ts`:
1. DELETE the local `diffParams` function (currently `useSynth.ts:104-126`, the block from the `// Returns the subset...` comment through the closing `}` of `diffParams`).
2. Add an import near the other `../project` imports (after the `import { project } from '../stores/project';` line):
```ts
import { diffParams } from '../project/paramDiff';
```
No other `useSynth` change in this task — every existing `diffParams(...)` call site now resolves to the import.

Run: `cd packages/client && npx vitest run src/composables/useSynth.test.ts`
Expected: all pass (behaviour identical — the audio watchers still use `diffParams`, now imported).

- [ ] **Step 5: Create `AudioEngine.ts`** — the full class (dead code; constructed nowhere yet)

`packages/client/src/audio/AudioEngine.ts`. Relocate the audio helpers, `AudioState`, `buildAudioState`, `ensureAudio`, `disposeSynth`'s audio half, `togglePlay`, `stopPlayback` from `useSynth.ts`. Reproduce bodies verbatim; the only mechanical change is `project` → the local `const project = this.deps.project;` alias at the top of `buildAudioState` and `togglePlay`, and module-scope `sequencer`/`audioState`/`bootstrapping`/`currentStep` becoming instance members.

```ts
import { ref, reactive, watch, computed, effectScope, shallowRef, type Ref, type EffectScope, type ComputedRef } from 'vue';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { type Project, type EngineType } from '../project';
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
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';
import { diffParams } from '../project/paramDiff';

// Worklet asset URL — must be a separate browser asset loaded via
// audioContext.audioWorklet.addModule, not bundled into the main chunk. Vite
// recognizes the `new URL(string-literal, import.meta.url)` pattern and emits
// the file alongside the main bundle with a hashed filename. The processor
// inside registers itself as 'pulse'. (Path is identical from audio/ or
// composables/ — both are one level under src/.)
const pulseWorkletUrl = new URL('../engine/worklets/pulse-processor.js', import.meta.url).href;

// synth2 worklet — esbuild-bundled into public/worklets by `build:worklet`
// (a static asset, NOT in Vite's module graph — see client package.json).
const synth2WorkletUrl = '/worklets/synth2-processor.js';
// kick2 worklet — same esbuild-bundled static-asset story as synth2.
const kick2WorkletUrl = '/worklets/kick2-processor.js';
// snare2 worklet — same esbuild-bundled static-asset story as kick2.
const snare2WorkletUrl = '/worklets/snare2-processor.js';
// hat2 worklet — same esbuild-bundled static-asset story as snare2.
const hat2WorkletUrl = '/worklets/hat2-processor.js';
// clap2 worklet — same esbuild-bundled static-asset story as hat2.
const clap2WorkletUrl = '/worklets/clap2-processor.js';

const ENGINE_SWAP_FADE_SECONDS = 0.02;

// Local copy of the engine-slice key list (already duplicated across preset.ts /
// storage.ts / normalize.ts; DRY-ing all copies is a separate cleanup).
const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'];

const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
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

// Mixer volume is stored as slider position 0..1 (perceptual). The actual
// AudioParam.gain needs a linear multiplier — convert via -54..+6 dB then
// 10^(dB/20). Slider at 0 is hard silence (matches muted semantics). The
// matching display formula lives in Knob.vue case 'db' — keep them in sync.
function sliderToLinearGain(slider: number): number {
  if (slider <= 0) return 0;
  const db = -54 + slider * 60;
  return Math.pow(10, db / 20);
}

// JSON-clone: walks string-keyed enumerable props only, skipping the Symbol
// metadata that Vue's reactive proxy attaches. structuredClone fails on
// reactive proxies because it tries to clone the proxy's internal flags.
// Safe here because our params are pure JSON: strings + numbers, no Dates,
// no NaN/Infinity, no functions.
function snapshot<T>(slice: T): T {
  return JSON.parse(JSON.stringify(slice));
}

export interface AudioState {
  ctx: AudioContext;
  trackAnalysers: AnalyserNode[];
  trackGains: GainNode[];
  // Sparse: a slot has an engine only while its track is enabled. Disabled
  // slots are `undefined` — building all TRACK_POOL_SIZE engines eagerly cost
  // ~190 always-running oscillators rendering silence.
  engines: (SoundEngine | undefined)[];
  // Engines mid anti-click fade, waiting on their dispose timer. dispose()
  // settles these immediately so no timer outlives the AudioContext.
  pendingDisposes: Map<ReturnType<typeof setTimeout>, SoundEngine>;
  scope: EffectScope;
}

export interface AudioEngineDeps {
  project: Project;
}

// AudioEngine — owns the AudioContext, the per-track sound engines, the track
// gains/analysers, the audio-reaction watchers, the Sequencer, and the transport
// (currentStep). Extracted from useSynth (Phase 4) so audio ownership + teardown
// are explicit. Long-lived, one per tab; the graph boots lazily on the first
// ensureAudio()/togglePlay(), and dispose() is the idempotent full teardown.
// Imports nothing from sync/ or useSynth — a one-directional, cycle-free edge.
export class AudioEngine {
  readonly sequencer = reactive(new Sequencer());
  readonly currentStep: Ref<number> = ref(-1);

  // shallowRef so the computed bindings below re-evaluate when ensureAudio()
  // flips this from null -> AudioState. A plain field would not be observed by
  // Vue, so the computeds would cache the initial null forever.
  private readonly audioState = shallowRef<AudioState | null>(null);

  // Single-flight bootstrap. Concurrent ensureAudio() calls during the
  // addModule window share one Promise so we never spawn two AudioContexts.
  private bootstrapping: Promise<AudioState> | null = null;

  // Audio-derived bindings. Return null until first ensureAudio() so the
  // Visualizer renders a flat line during the pre-gesture window.
  readonly trackAnalysers: ComputedRef<AnalyserNode[] | null> = computed(() => this.audioState.value?.trackAnalysers ?? null);
  readonly trackGains: ComputedRef<GainNode[] | null> = computed(() => this.audioState.value?.trackGains ?? null);

  constructor(private readonly deps: AudioEngineDeps) {}

  private async buildAudioState(): Promise<AudioState> {
    const project = this.deps.project;
    const ctx = new AudioContext();

    // Pulse oscillator worklet must be registered before any SynthVoice (and
    // its inner OscillatorModule) constructs an AudioWorkletNode('pulse'). The
    // module load is async; the rest of the graph wiring must wait.
    await ctx.audioWorklet.addModule(pulseWorkletUrl);
    // synth2 worklet must likewise be registered before any Synth2Engine
    // constructs an AudioWorkletNode('synth2').
    await ctx.audioWorklet.addModule(synth2WorkletUrl);
    // kick2 worklet must likewise be registered before any Kick2Engine constructs
    // an AudioWorkletNode('kick2').
    await ctx.audioWorklet.addModule(kick2WorkletUrl);
    // snare2 worklet must likewise be registered before any Snare2Engine constructs
    // an AudioWorkletNode('snare2').
    await ctx.audioWorklet.addModule(snare2WorkletUrl);
    // hat2 worklet must likewise be registered before any Hat2Engine constructs an
    // AudioWorkletNode('hat2').
    await ctx.audioWorklet.addModule(hat2WorkletUrl);
    // clap2 worklet must likewise be registered before any Clap2Engine constructs an
    // AudioWorkletNode('clap2').
    await ctx.audioWorklet.addModule(clap2WorkletUrl);

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-12, ctx.currentTime);
    compressor.knee.setValueAtTime(30, ctx.currentTime);
    compressor.ratio.setValueAtTime(12, ctx.currentTime);
    compressor.attack.setValueAtTime(0.003, ctx.currentTime);
    compressor.release.setValueAtTime(0.25, ctx.currentTime);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.6, ctx.currentTime);

    compressor.connect(masterGain);
    masterGain.connect(ctx.destination);

    // Per-track analysers tee off each trackGain so the focused panel's
    // oscilloscope shows only that channel, not the summed mix.
    const trackGains: GainNode[] = [];
    const trackAnalysers: AnalyserNode[] = [];
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.8, ctx.currentTime);
      g.connect(compressor);
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      g.connect(a);
      trackGains.push(g);
      trackAnalysers.push(a);
    }

    const engines: (SoundEngine | undefined)[] = new Array(TRACK_POOL_SIZE).fill(undefined);

    const pendingDisposes: Map<ReturnType<typeof setTimeout>, SoundEngine> = new Map();

    // Fade trackGain to 0 over ~20ms so dispose()'s synchronous osc.stop()
    // doesn't click, then dispose and restore gains (D4 semantics). Shared by
    // engine-type swaps and slot disables. The timer is tracked in
    // pendingDisposes so dispose() can settle it early.
    const fadeOutAndDispose = (i: number, engine: SoundEngine) => {
      trackGains[i].gain.setTargetAtTime(0, ctx.currentTime, ENGINE_SWAP_FADE_SECONDS / 3);
      const timer = setTimeout(() => {
        pendingDisposes.delete(timer);
        engine.dispose();
        updateMixerGains();
      }, (ENGINE_SWAP_FADE_SECONDS * 1000) + 5);
      pendingDisposes.set(timer, engine);
    };

    const syncTrackToEngine = (i: number) => {
      const track = project.tracks[i];
      const existing = engines[i];

      // Disabled slot: no engine at all. Tear down whatever is there so a
      // disabled track costs zero audio-thread time, not just zero gain.
      if (!track.enabled) {
        if (existing) {
          engines[i] = undefined;
          fadeOutAndDispose(i, existing);
        }
        return;
      }

      const targetType = track.engineType;
      if (!existing || existing.engineType !== targetType) {
        if (existing) fadeOutAndDispose(i, existing);
        engines[i] = engineFactories[targetType](ctx, trackGains[i]);
      }

      engines[i]!.applyParams(track.engines[targetType] as Record<string, any>);
    };

    const updateMixerGains = () => {
      // Solo is scoped to enabled tracks only — soloing has no meaning for a
      // disabled slot, and a disabled slot must never count toward anySoloed.
      const anySoloed = project.tracks.some(t => t.enabled && t.mixer?.soloed);
      for (let i = 0; i < TRACK_POOL_SIZE; i++) {
        const track = project.tracks[i];
        // A disabled slot is always silent regardless of its mixer state.
        const audible = track.enabled && (anySoloed
          ? (track.mixer.soloed && !track.mixer.muted)
          : !track.mixer.muted);
        const targetGain = audible ? sliderToLinearGain(track.mixer.volume) : 0;
        trackGains[i].gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
      }
    };

    // Build engines for ENABLED slots only + apply their current project tracks
    // (which may already carry pre-play knob edits). Disabled slots stay empty
    // until their `enabled` watcher fires.
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      syncTrackToEngine(i);
    }
    updateMixerGains();

    // Audio-reaction watchers ONLY: they drive the engine graph and track gains,
    // so they live with the AudioContext (built on first PLAY). Outbound sync no
    // longer uses watchers at all. Nothing in this scope enqueues an op; these
    // bodies only mutate audio nodes. flush:'sync' keeps each reaction in step
    // with the synchronous applyRemote write, and the bodies are guard-free so
    // remote ops drive audio too.
    const scope = effectScope(true);
    scope.run(() => {
      for (let i = 0; i < TRACK_POOL_SIZE; i++) {
        // Engine-type change: dispose the old engine, build the new one, apply the
        // whole slice. Fires for remote swaps too.
        watch(
          () => project.tracks[i].engineType,
          () => { syncTrackToEngine(i); },
          { flush: 'sync' },
        );

        // Per-slice param edits feed the active engine. snapshot()+diff lets Vue
        // track nested fields without deep:true and gives a real before/after.
        for (const slice of ENGINE_SLICES) {
          watch(
            () => snapshot(project.tracks[i].engines[slice]),
            (newVal, oldVal) => {
              if (project.tracks[i].engineType !== slice) return;
              const engine = engines[i];
              if (!engine) return; // disabled slot — params apply on enable via syncTrackToEngine
              const changed = diffParams(
                newVal as unknown as Record<string, unknown>,
                oldVal as unknown as Record<string, unknown>,
              );
              if (changed) engine.applyParams(changed);
            },
            { flush: 'sync' },
          );
        }

        // Mixer: any change recomputes all track gains (solo logic is global).
        watch(
          () => snapshot(project.tracks[i].mixer),
          () => { updateMixerGains(); },
          { flush: 'sync' },
        );

        // enabled toggles the slot's engine lifecycle: enable constructs the
        // engine (and applies the slice), disable fade-disposes it.
        watch(
          () => project.tracks[i].enabled,
          () => {
            syncTrackToEngine(i);
            updateMixerGains();
          },
          { flush: 'sync' },
        );
      }
    });

    return { ctx, trackAnalysers, trackGains, engines, pendingDisposes, scope };
  }

  ensureAudio = async (): Promise<AudioState> => {
    if (this.audioState.value) return this.audioState.value;
    if (!this.bootstrapping) {
      this.bootstrapping = this.buildAudioState().then((s) => {
        this.audioState.value = s;
        return s;
      });
    }
    return this.bootstrapping;
  };

  togglePlay = async (): Promise<void> => {
    const project = this.deps.project;
    // First user gesture: this is where the AudioContext + engines + watchers
    // come alive. Doing it here (not at module load) eliminates Chrome's
    // "AudioContext was not allowed to start" warning.
    const state = await this.ensureAudio();

    if (state.ctx.state === 'suspended') {
      state.ctx.resume();
    }

    if (this.sequencer.isPlaying) {
      this.sequencer.stop();
      this.currentStep.value = -1;
    } else {
      this.sequencer.start(state.ctx, () => project.bpm, (stepIndex, time) => {
        this.currentStep.value = stepIndex;

        for (let i = 0; i < TRACK_POOL_SIZE; i++) {
          const track = project.tracks[i];
          if (!track.enabled) continue;
          // Engine construction rides the synchronous enabled watcher, so an
          // enabled track always has one — guard anyway so a scheduling tick
          // racing a toggle can't crash the audio callback.
          const engine = state.engines[i];
          if (!engine) continue;
          const step = track.steps[stepIndex % track.patternLength];
          if (step.note && !step.muted) {
            const engineTypeI = track.engineType;
            if (engineTypeI === 'synth') {
              const currentMode = track.engines.synth.mode;
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentMode === 'poly') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                engine.trigger(freqs, duration, time, step.velocity);
              } else {
                const freq = noteToFreq(step.note, step.octave);
                engine.trigger(freq, duration, time, step.velocity);
              }
            } else if (engineTypeI === 'synth2') {
              const currentMode = track.engines.synth2.mode;
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentMode === 'poly') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                engine.trigger(freqs, duration, time, step.velocity);
              } else {
                engine.trigger(noteToFreq(step.note, step.octave), duration, time, step.velocity);
              }
            } else {
              // Drums are fire-and-forget: pitch + decay come from the engine's
              // Tune/Decay knobs, not from step data. freq/duration are passed
              // as 0 — every drum engine ignores them. step.note here is used
              // only as a trigger flag (null = no trigger) by the outer if.
              engine.trigger(0, 0, time, step.velocity);
            }
          }
        }
      });
    }
  };

  // Stop the sequencer if it's running. Used when leaving the studio for the
  // lobby. No-op if audio never booted or playback is already stopped; the
  // audio graph stays up so the next PLAY is instant.
  stopPlayback = (): void => {
    if (this.sequencer.isPlaying) {
      this.sequencer.stop();
      this.currentStep.value = -1;
    }
  };

  // Idempotent full teardown for page unload / HMR / tests. Stops the transport,
  // settles in-flight fade-disposes, disposes all engines, and closes the ctx.
  // A second call is a no-op (audioState already null). Does NOT touch sync.
  dispose(): void {
    const state = this.audioState.value;
    if (!state) return;
    state.scope.stop();
    // Settle in-flight fade-disposes first so their timers never fire against a
    // closed AudioContext (or, in tests, after globals are torn down).
    for (const [timer, engine] of state.pendingDisposes) {
      clearTimeout(timer);
      engine.dispose();
    }
    state.pendingDisposes.clear();
    for (const engine of state.engines) {
      engine?.dispose(); // sparse — disabled slots have no engine
    }
    state.ctx.close().catch(() => { /* ctx may already be closed */ });
    this.audioState.value = null;
    this.bootstrapping = null;
    // Stop the transport so no scheduler interval outlives the closed ctx
    // (the orphaned-transport fix this extraction exists to make explicit).
    this.sequencer.stop();
    this.currentStep.value = -1;
  }
}
```

- [ ] **Step 6: Write `AudioEngine.test.ts`** (pure TS, MockAudioContext — no `.vue`)

`packages/client/src/audio/AudioEngine.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, nextTick } from 'vue';
import { freshProject, type Project } from '../project';
import { TRACK_POOL_SIZE } from '@fiddle/shared';

// Minimal Web Audio mock (same shape as useSynth.test / TrackMixer.test).
class MockAudioNode { connect = vi.fn(); disconnect = vi.fn(); context = { currentTime: 0 }; }
class MockAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn().mockImplementation((val: number) => { this.value = val; });
}
class MockGainNode extends MockAudioNode { gain = new MockAudioParam(); }
class MockOscillatorNode extends MockAudioNode {
  frequency = new MockAudioParam(); detune = new MockAudioParam(); type = 'sine';
  start = vi.fn(); stop = vi.fn();
}
class MockBiquadFilterNode extends MockAudioNode { frequency = new MockAudioParam(); Q = new MockAudioParam(); type = 'lowpass'; }
class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(); knee = new MockAudioParam(); ratio = new MockAudioParam();
  attack = new MockAudioParam(); release = new MockAudioParam();
}
class MockAnalyserNode extends MockAudioNode { fftSize = 1024; }
class MockAudioWorkletNode extends MockAudioNode {
  parameters = new Map<string, MockAudioParam>([
    ['frequency', new MockAudioParam()], ['detune', new MockAudioParam()], ['pulseWidth', new MockAudioParam()],
  ]);
}
let audioContextCtorCalls = 0;
class MockAudioContext {
  state = 'suspended'; currentTime = 0; sampleRate = 44100;
  destination = new MockAudioNode();
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockImplementation(() => { this.state = 'running'; return Promise.resolve(); });
  constructor() { audioContextCtorCalls++; }
  createGain() { return new MockGainNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
}
vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

import { AudioEngine } from './AudioEngine';

function makeEngine() {
  const project = reactive(freshProject()) as Project;
  return { project, engine: new AudioEngine({ project }) };
}

describe('AudioEngine', () => {
  beforeEach(() => { audioContextCtorCalls = 0; });

  it('construction is side-effect-free (no AudioContext, bindings null)', () => {
    const { engine } = makeEngine();
    expect(audioContextCtorCalls).toBe(0);
    expect(engine.trackAnalysers.value).toBeNull();
    expect(engine.trackGains.value).toBeNull();
    expect(engine.sequencer.isPlaying).toBe(false);
  });

  it('ensureAudio builds the graph and is single-flight', async () => {
    const { engine } = makeEngine();
    const [a, b] = await Promise.all([engine.ensureAudio(), engine.ensureAudio()]);
    expect(a).toBe(b);                       // one shared bootstrap
    expect(audioContextCtorCalls).toBe(1);   // exactly one AudioContext
    expect(engine.trackGains.value).toHaveLength(TRACK_POOL_SIZE);
    expect(engine.trackAnalysers.value).toHaveLength(TRACK_POOL_SIZE);
    expect(a.engines[0]).toBeDefined();      // track 0 enabled by default
  });

  it('forwards only the changed key when one active-engine param is mutated', async () => {
    const { project, engine } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();

    project.tracks[0].engines.synth.filterCutoff = 1234;
    await nextTick();

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith({ filterCutoff: 1234 });
  });

  it('dispose closes the ctx, stops the transport, and is idempotent', async () => {
    const { engine } = makeEngine();
    const state = await engine.ensureAudio();
    const closeSpy = state.ctx.close as unknown as ReturnType<typeof vi.fn>;

    await engine.togglePlay();               // start transport
    expect(engine.sequencer.isPlaying).toBe(true);

    engine.dispose();
    expect(engine.sequencer.isPlaying).toBe(false);
    expect(engine.currentStep.value).toBe(-1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(engine.trackGains.value).toBeNull();

    engine.dispose();                        // second call: no-op
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 7: Run the AudioEngine test + full client suite + typecheck — expect all green**

Run: `cd packages/client && npx vitest run src/audio/AudioEngine.test.ts`
Expected: 4 passed.

Run: `cd packages/client && npm test`
Expected: full client suite green (the existing `useSynth.test.ts` and `TrackMixer.test.ts` still pass — `diffParams` now imported, `AudioEngine` is dead code not yet wired).

Run (repo root): `npm run typecheck`
Expected: clean across all 3 workspaces.

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/project/paramDiff.ts packages/client/src/project/paramDiff.test.ts packages/client/src/audio/AudioEngine.ts packages/client/src/audio/AudioEngine.test.ts packages/client/src/composables/useSynth.ts
git commit -m "feat(audio): add AudioEngine class + paramDiff module (phase 4 task 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

## Task 2: Atomic facade-preserving swap in `useSynth.ts`

Wire the `AudioEngine` singleton into `useSynth`, delete the now-relocated audio code, and rewrite the audio exports as delegators. After this task the app runs entirely through the extracted engine; behaviour is byte-identical modulo the two called-out consequences.

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`

**Interfaces:**
- Consumes from Task 1: `import { AudioEngine } from '../audio/AudioEngine';` — `new AudioEngine({ project })`, `.ensureAudio()`, `.togglePlay`, `.stopPlayback`, `.dispose()`, `.sequencer`, `.currentStep`, `.trackAnalysers`, `.trackGains`.

- [ ] **Step 1: Add the import + construct the eager singleton**

In `packages/client/src/composables/useSynth.ts`, add to the imports:
```ts
import { AudioEngine } from '../audio/AudioEngine';
```
After the `const session = new SyncSession({ ... });` block, add:
```ts
// The one audio engine for this tab. Long-lived; the AudioContext + engines boot
// lazily on first ensureAudio()/togglePlay(), dispose() is the page-unload
// teardown. Owns ctx/engines/gains/analysers/Sequencer + the transport
// (currentStep), re-exported below so consumers are untouched. Constructed
// eagerly and side-effect-free (no AudioContext until first play).
const audioEngine = new AudioEngine({ project });
```

- [ ] **Step 2: Delete the relocated audio code from `useSynth.ts`**

Remove these blocks (all now living in `AudioEngine.ts`):
- The 6 worklet-URL `const` declarations and their comments (`pulseWorkletUrl` … `clap2WorkletUrl`).
- `const sequencer = reactive(new Sequencer());`
- `const ENGINE_SWAP_FADE_SECONDS`, and the `engineFactories` record.
- `function sliderToLinearGain`, `function snapshot`.
- The `interface AudioState { … }`, `const audioState = shallowRef<AudioState | null>(null);`
- `async function buildAudioState(): Promise<AudioState> { … }` (the whole function).
- `let bootstrapping: Promise<AudioState> | null = null;` and `async function ensureAudio(): Promise<AudioState> { … }`.
- `export function disposeSynth() { … }` — replaced in Step 3.

Keep: `ENGINE_SLICES` (still used by the sync emitters `snapshotProjectForSync`/`syncWholeProjectDiff`), `diffParams` import (still used by the sync emitters), `Sequencer`/engine-class imports ONLY if still referenced — see Step 5.

- [ ] **Step 3: Rewrite `disposeSynth` as the two-teardown delegator**

Replace the deleted `disposeSynth` with:
```ts
// Exposed primarily for tests; production code does not call this. Tears down
// the audio engine (ctx/engines/transport) then the sync layer so a re-init
// (or a test) starts clean.
export function disposeSynth() {
  audioEngine.dispose();
  session.dispose();
}
```

- [ ] **Step 4: Rewrite the audio exports in `useSynth()` as delegators**

Inside `useSynth()`:
1. DELETE `const currentStep = ref(-1);` (now `audioEngine.currentStep`).
2. DELETE the `trackAnalysers` / `trackGains` computeds (lines projecting `audioState.value?.…`).
3. DELETE the `togglePlay` and `stopPlayback` closures.
4. In the returned object, replace the audio members with delegators:
```ts
    sequencer: audioEngine.sequencer,
    trackAnalysers: audioEngine.trackAnalysers,
    trackGains: audioEngine.trackGains,
    currentStep: audioEngine.currentStep,
    togglePlay: audioEngine.togglePlay,
    stopPlayback: audioEngine.stopPlayback,
    ensureAudio: audioEngine.ensureAudio,
```
Keep every non-audio return member (`project`, `bpm`, `activeTrackIndex`, `focusedTrack`, `waveforms`, `shortestActiveNoteDuration`, `selectTrack`, `setFocusedTrack`, `getTrackEngineType`, `enabledTrackCount`, `addTrack`, `removeTrack`, and the whole sync surface) exactly as-is.

> Note: `currentStep` and `sequencer` were previously created per `useSynth()` call; they are now the single `AudioEngine`-owned instances (called-out consequence #1). `activeTrackIndex` stays a per-call ref — it is view state, not audio.

- [ ] **Step 5: Prune now-unused imports**

Remove imports from `useSynth.ts` that are no longer referenced after the deletions:
- `SoundEngine`, `SynthEngine`, `KickEngine`, `HatEngine`, `SnareEngine`, `ClapEngine`, `Synth2Engine`, `Kick2Engine`, `Snare2Engine`, `Hat2Engine`, `Clap2Engine`, `Sequencer`, `noteToFreq`, `resolveChordFreqs`.
- From the `vue` import, drop `effectScope`, `shallowRef`, `EffectScope` if no longer used; **keep** `ref`, `reactive`, `watch`, `computed`, `ComputedRef`, and any others still referenced (e.g. `OscillatorTypeLiteral` from shared for `waveforms`).

Let the typecheck in Step 6 be the authority on exactly which imports remain — remove only what `vue-tsc` flags as unused (`noUnusedLocals`) plus the obviously-dead engine imports above.

- [ ] **Step 6: Run the full client suite + typecheck — expect all green**

Run: `cd packages/client && npm test`
Expected: full client suite green. `useSynth.test.ts` and `TrackMixer.test.ts` now exercise the delegators (facade) — the safety net proving byte-identical behaviour.

Run (repo root): `npm run typecheck`
Expected: clean across all 3 workspaces (no unused-import errors).

- [ ] **Step 7: Verify the facade invariant**

Run: `git diff --stat main`
Expected: exactly these files — `packages/client/src/audio/AudioEngine.ts`, `packages/client/src/audio/AudioEngine.test.ts`, `packages/client/src/project/paramDiff.ts`, `packages/client/src/project/paramDiff.test.ts`, `packages/client/src/composables/useSynth.ts`. **No `.vue` or other consumer file changed.**

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/composables/useSynth.ts
git commit -m "refactor(audio): route useSynth through the AudioEngine singleton (phase 4 task 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir"
```

---

## Browser verification (after Task 2, before merge)

Per the standing rule, run a two-tab browser pass on the **local Docker DB** (`docker compose up -d` then `npm run dev:obs` — **never `npm run dev`**, which targets prod). Confirm with a clean console:
- Audio boots on first PLAY; the sequencer plays; the playhead (`currentStep`) advances.
- A knob turn changes the sound live (param watcher path); an engine-type swap rebuilds the voice; mute/solo gates channels.
- A second tab hears a peer's edits (remote ops still drive audio through the retained watchers).
- Leaving to the lobby stops playback (`stopPlayback`); re-entering a room plays cleanly.

Close the browser and stop the dev servers when done.

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- AudioEngine owns ctx/engines/sequencer + idempotent dispose → Task 1 Step 5, dispose test Task 1 Step 6. ✓
- Facade-preserving, useSynth delegates → Task 2. ✓
- `AudioEngine` imports nothing from sync/useSynth → import list in Task 1 Step 5 (only vue/shared/engine/sequencer/utils/paramDiff). ✓
- Neutral `paramDiff.ts` shared by both units → Task 1 Steps 1–4. ✓
- `currentStep` single-owned consequence → Task 2 Step 4 note + Global Constraints. ✓
- `ENGINE_SLICES` local copy (not moved) → Task 1 Step 5. ✓
- Tests: pure-TS AudioEngine test + paramDiff test; existing facade tests as safety net → Task 1 Steps 2/6, Task 2 Step 6. ✓
- Invariant diff → Task 2 Step 7. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows complete code. ✓

**3. Type consistency:** `AudioState`/`AudioEngineDeps`/`AudioEngine` names and the delegator member names (`ensureAudio`, `togglePlay`, `stopPlayback`, `trackAnalysers`, `trackGains`, `currentStep`, `sequencer`) match between Task 1 (definitions) and Task 2 (consumption). `diffParams` signature matches its call sites. ✓
