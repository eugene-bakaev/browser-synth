import { ref, reactive, watch, computed, effectScope, shallowRef, type WritableComputedRef, type EffectScope, type ComputedRef } from 'vue';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';
// Worklet asset URL — must be a separate browser asset loaded via
// audioContext.audioWorklet.addModule, not bundled into the main chunk. Vite
// recognizes the `new URL(string-literal, import.meta.url)` pattern and emits
// the file alongside the main bundle with a hashed filename. The processor
// inside registers itself as 'pulse'.
const pulseWorkletUrl = new URL('../engine/worklets/pulse-processor.js', import.meta.url).href;

import {
  type Project,
  type ProjectTrack,
  type EngineType,
  type EngineParamsMap,
  loadProject,
  installAutoSave,
} from '../project';

// === Pure data state — built from localStorage (or fresh) at module init. ===

const project: Project = reactive(loadProject());
installAutoSave(project);   // debounced localStorage writes

const sequencer = reactive(new Sequencer());

// === Engine factories — unchanged ===
const ENGINE_SWAP_FADE_SECONDS = 0.02;

const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap'];

const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth: (ctx, dest) => new SynthEngine(ctx, dest),
  kick:  (ctx, dest) => new KickEngine(ctx, dest),
  hat:   (ctx, dest) => new HatEngine(ctx, dest),
  snare: (ctx, dest) => new SnareEngine(ctx, dest),
  clap:  (ctx, dest) => new ClapEngine(ctx, dest),
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

// Returns the subset of `newVal` keys whose values differ from `oldVal`, or
// null if nothing changed. Used to feed engine.applyParams() the minimum set
// of writes per knob turn instead of the full slice (was 13 writes/knob for
// the synth; now typically 1).
function diffParams<T extends Record<string, unknown>>(
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

// === Audio state — lazy. Built on first user gesture (or test-driven ensureAudio). ===

interface AudioState {
  ctx: AudioContext;
  trackAnalysers: AnalyserNode[];
  trackGains: GainNode[];
  engines: SoundEngine[];
  scope: EffectScope;
}

// shallowRef so the computed bindings below (trackAnalysers, trackGains) actually
// re-evaluate when ensureAudio() flips this from null → AudioState. A plain
// `let` looks identical here but Vue can't observe the assignment, so the
// computeds would cache the initial null forever (oscilloscope stays flat).
const audioState = shallowRef<AudioState | null>(null);

async function buildAudioState(): Promise<AudioState> {
  const ctx = new AudioContext();

  // Pulse oscillator worklet must be registered before any SynthVoice (and
  // its inner OscillatorModule) constructs an AudioWorkletNode('pulse'). The
  // module load is async; the rest of the graph wiring must wait.
  await ctx.audioWorklet.addModule(pulseWorkletUrl);

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
  for (let i = 0; i < 4; i++) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, ctx.currentTime);
    g.connect(compressor);
    const a = ctx.createAnalyser();
    a.fftSize = 1024;
    g.connect(a);
    trackGains.push(g);
    trackAnalysers.push(a);
  }

  const engines: SoundEngine[] = [];

  const syncTrackToEngine = (i: number) => {
    const track = project.tracks[i];
    const targetType = track.engineType;
    const existing = engines[i];

    if (!existing || existing.engineType !== targetType) {
      if (existing) {
        // Fade trackGain to 0 over ~20ms so dispose()'s synchronous osc.stop() doesn't click.
        trackGains[i].gain.setTargetAtTime(0, ctx.currentTime, ENGINE_SWAP_FADE_SECONDS / 3);
        const oldEngine = existing;
        setTimeout(() => {
          oldEngine.dispose();
          updateMixerGains();
        }, (ENGINE_SWAP_FADE_SECONDS * 1000) + 5);
      }
      engines[i] = engineFactories[targetType](ctx, trackGains[i]);
    }

    engines[i].applyParams(track.engines[targetType] as Record<string, any>);
  };

  const updateMixerGains = () => {
    const anySoloed = project.tracks.some(t => t.mixer?.soloed);
    for (let i = 0; i < 4; i++) {
      const track = project.tracks[i];
      const audible = anySoloed
        ? (track.mixer.soloed && !track.mixer.muted)
        : !track.mixer.muted;
      const targetGain = audible ? sliderToLinearGain(track.mixer.volume) : 0;
      trackGains[i].gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
    }
  };

  // Build engines + apply current project tracks (which may already carry pre-play knob edits).
  for (let i = 0; i < 4; i++) {
    syncTrackToEngine(i);
  }
  updateMixerGains();

  // Watchers live in a detached EffectScope so they can be stopped explicitly
  // via disposeSynth() — without this the original code had no teardown path.
  const scope = effectScope(true);
  scope.run(() => {
    for (let i = 0; i < 4; i++) {
      // Engine-type change triggers full sync: dispose old, build new, apply
      // the entire new slice. Slice watchers handle the steady-state case.
      watch(
        () => project.tracks[i].engineType,
        () => syncTrackToEngine(i)
      );

      // Per-slice narrow watchers. Wrapping the getter in snapshot() does two
      // things: (a) Vue tracks every nested field as a dependency (no need
      // for `deep: true`); (b) each fire produces a fresh plain snapshot so
      // newVal/oldVal can be diffed — Vue would otherwise hand us the same
      // reactive proxy reference for both.
      for (const slice of ENGINE_SLICES) {
        watch(
          () => snapshot(project.tracks[i].engines[slice]),
          (newVal, oldVal) => {
            // Only apply if this slice is the active engine for the track.
            // Edits to a non-active slice are buffered until that engine
            // becomes active (the engineType watcher then full-syncs).
            if (project.tracks[i].engineType !== slice) return;
            const changed = diffParams(newVal as unknown as Record<string, unknown>, oldVal as unknown as Record<string, unknown>);
            if (changed) engines[i].applyParams(changed);
          }
        );
      }

      // Mixer watcher stays deep: solo logic is global, so any change has to
      // recompute all 4 track gains via updateMixerGains.
      watch(
        () => project.tracks[i].mixer,
        () => updateMixerGains(),
        { deep: true }
      );
    }
  });

  return { ctx, trackAnalysers, trackGains, engines, scope };
}

// Single-flight bootstrap. Concurrent ensureAudio() calls during the
// addModule window share one Promise so we never spawn two AudioContexts.
let bootstrapping: Promise<AudioState> | null = null;

async function ensureAudio(): Promise<AudioState> {
  if (audioState.value) return audioState.value;
  if (!bootstrapping) {
    bootstrapping = buildAudioState().then(s => {
      audioState.value = s;
      return s;
    });
  }
  return bootstrapping;
}

// Exposed primarily for tests; production code does not call this.
export function disposeSynth() {
  const state = audioState.value;
  if (!state) return;
  state.scope.stop();
  for (const engine of state.engines) {
    engine.dispose();
  }
  state.ctx.close().catch(() => { /* ctx may already be closed */ });
  audioState.value = null;
  bootstrapping = null;
}

export function useSynth() {
  const currentStep = ref(-1);
  const activeTrackIndex = ref<number | null>(null); // null means 4-track overview

  const waveforms: OscillatorTypeLiteral[] = ['sine', 'square', 'sawtooth', 'triangle'];

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

  const engineType = computed({
    get: () => activeTrackIndex.value !== null ? project.tracks[activeTrackIndex.value].engineType : 'synth' as EngineType,
    set: (val: EngineType) => {
      if (activeTrackIndex.value !== null) project.tracks[activeTrackIndex.value].engineType = val;
    }
  });

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

  const bpm = computed({
    get: () => project.bpm,
    set: (v: number) => { project.bpm = v; },
  });

  // --- Synth params ---
  const osc1Type = trackParam('synth', 'osc1Type', 'sawtooth');
  const osc2Type = trackParam('synth', 'osc2Type', 'sawtooth');
  const osc1Coarse = trackParam('synth', 'osc1Coarse', 0);
  const osc1Fine = trackParam('synth', 'osc1Fine', 0);
  const osc2Coarse = trackParam('synth', 'osc2Coarse', 0);
  const osc2Fine = trackParam('synth', 'osc2Fine', 0);
  const osc1Level = trackParam('synth', 'osc1Level', 0.5);
  const osc2Level = trackParam('synth', 'osc2Level', 0.5);
  const osc1PulseWidth = trackParam('synth', 'osc1PulseWidth', 0.5);
  const osc2PulseWidth = trackParam('synth', 'osc2PulseWidth', 0.5);
  const filterCutoff = trackParam('synth', 'filterCutoff', 2000);
  const filterRes = trackParam('synth', 'filterRes', 1);
  const filterEnvAmount = trackParam('synth', 'filterEnvAmount', 2.4);
  const filterEnv = trackParam('synth', 'filterEnv', { a: 0.01, d: 0.2, s: 0.5, r: 0.5 });
  const ampEnv = trackParam('synth', 'ampEnv', { a: 0.01, d: 0.2, s: 0.5, r: 0.5 });

  // --- Kick params ---
  const kickTune = trackParam('kick', 'tune', 55);
  const kickDecay = trackParam('kick', 'decay', 0.3);
  const kickClick = trackParam('kick', 'click', 0.5);

  // --- Hat params ---
  const hatDecay = trackParam('hat', 'decay', 0.15);
  const hatTone = trackParam('hat', 'tone', 8000);
  const hatMetallic = trackParam('hat', 'metallic', 0.5);

  // --- Snare params ---
  const snareTune = trackParam('snare', 'tune', 180);
  const snareDecay = trackParam('snare', 'decay', 0.25);
  const snareSnappy = trackParam('snare', 'snappy', 0.5);

  // --- Clap params ---
  const clapDecay = trackParam('clap', 'decay', 0.25);
  const clapTone = trackParam('clap', 'tone', 1000);
  const clapSloppy = trackParam('clap', 'sloppy', 0.015);

  const shortestActiveNoteDuration = computed<number | null>(() => {
    if (activeTrackIndex.value === null) return null;
    const track = project.tracks[activeTrackIndex.value];
    if (!track) return null;
    const activeSteps = track.steps.filter(s => s.note !== null && !s.muted);
    if (activeSteps.length === 0) return null;
    const tickDuration = (60 / project.bpm) / 4;
    const minTicks = Math.min(...activeSteps.map(s => s.length));
    return minTicks * tickDuration;
  });

  // Audio-derived bindings. `trackAnalysers` returns null until first
  // ensureAudio() so Visualizer renders a flat line during the pre-gesture window.
  const trackAnalysers: ComputedRef<AnalyserNode[] | null> = computed(() => audioState.value?.trackAnalysers ?? null);
  const trackGains: ComputedRef<GainNode[] | null> = computed(() => audioState.value?.trackGains ?? null);

  const togglePlay = async () => {
    // First user gesture: this is where the AudioContext + engines + watchers
    // come alive. Doing it here (not at module load) eliminates Chrome's
    // "AudioContext was not allowed to start" warning. The await covers the
    // worklet module load (~few ms on first play, instant thereafter).
    const state = await ensureAudio();

    if (state.ctx.state === 'suspended') {
      state.ctx.resume();
    }

    if (sequencer.isPlaying) {
      sequencer.stop();
      currentStep.value = -1;
    } else {
      sequencer.start(state.ctx, () => project.bpm, (stepIndex, time) => {
        currentStep.value = stepIndex;

        for (let i = 0; i < 4; i++) {
          const track = project.tracks[i];
          const step = track.steps[stepIndex];
          if (step.note && !step.muted) {
            const engineTypeI = track.engineType;
            if (engineTypeI === 'synth') {
              const currentMode = track.engines.synth.mode;
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentMode === 'poly') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                state.engines[i].trigger(freqs, duration, time, step.velocity);
              } else {
                const freq = noteToFreq(step.note, step.octave);
                state.engines[i].trigger(freq, duration, time, step.velocity);
              }
            } else {
              // Drums are fire-and-forget: pitch + decay come from the engine's
              // Tune/Decay knobs, not from step data. freq/duration are passed
              // as 0 — every drum engine ignores them. step.note here is used
              // only as a trigger flag (null = no trigger) by the outer if.
              state.engines[i].trigger(0, 0, time, step.velocity);
            }
          }
        }
      });
    }
  };

  const selectTrack = (index: number | null) => {
    activeTrackIndex.value = index;
  };

  const getTrackEngineType = (index: number): EngineType => {
    return project.tracks[index].engineType;
  };

  return {
    project,                                       // NEW: single source of truth
    sequencer,
    bpm,                                           // NEW: writable computed against project.bpm
    trackAnalysers,
    trackGains,
    activeTrackIndex,
    currentStep,
    waveforms,
    engineType,
    synthMode,
    osc1Type,
    osc2Type,
    osc1Coarse,
    osc1Fine,
    osc2Coarse,
    osc2Fine,
    osc1Level,
    osc2Level,
    osc1PulseWidth,
    osc2PulseWidth,
    filterCutoff,
    filterRes,
    filterEnvAmount,
    filterEnv,
    ampEnv,
    shortestActiveNoteDuration,
    kickTune,
    kickDecay,
    kickClick,
    hatDecay,
    hatTone,
    hatMetallic,
    snareTune,
    snareDecay,
    snareSnappy,
    clapDecay,
    clapTone,
    clapSloppy,
    togglePlay,
    selectTrack,
    getTrackEngineType,
    // Force audio init without playing — needed by tests and any consumer
    // that needs the audio graph up before the first togglePlay.
    ensureAudio,
  };
}
