import { ref, reactive, watch, computed, effectScope, shallowRef, type WritableComputedRef, type EffectScope, type ComputedRef } from 'vue';
import { SoundEngine } from '../engine/types';
import { SynthEngine, type SynthEngineParams } from '../engine/SynthEngine';
import { KickEngine, type KickEngineParams } from '../engine/KickEngine';
import { HatEngine, type HatEngineParams } from '../engine/HatEngine';
import { SnareEngine, type SnareEngineParams } from '../engine/SnareEngine';
import { ClapEngine, type ClapEngineParams } from '../engine/ClapEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';

// === Pure data state — safe to live at module scope (no audio nodes here) ===

const sequencer = reactive(new Sequencer());

export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

export interface MixerState {
  volume: number;
  muted: boolean;
  soloed: boolean;
}

export interface TrackState {
  engineType: EngineType;
  playMode: 'mono' | 'chord';
  synth: SynthEngineParams;
  kick: KickEngineParams;
  hat: HatEngineParams;
  snare: SnareEngineParams;
  clap: ClapEngineParams;
  mixer: MixerState;
}

export const DEFAULT_MIXER_STATE: MixerState = {
  volume: 0.8,
  muted: false,
  soloed: false,
};

const trackStates = reactive<TrackState[]>(Array(4).fill(null).map(() => ({
  engineType: 'synth' as EngineType,
  playMode: 'mono' as const,
  synth: structuredClone(SynthEngine.DEFAULT_PARAMS),
  kick:  structuredClone(KickEngine.DEFAULT_PARAMS),
  hat:   structuredClone(HatEngine.DEFAULT_PARAMS),
  snare: structuredClone(SnareEngine.DEFAULT_PARAMS),
  clap:  structuredClone(ClapEngine.DEFAULT_PARAMS),
  mixer: { ...DEFAULT_MIXER_STATE },
})));

const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth: (ctx, dest) => new SynthEngine(ctx, dest),
  kick:  (ctx, dest) => new KickEngine(ctx, dest),
  hat:   (ctx, dest) => new HatEngine(ctx, dest),
  snare: (ctx, dest) => new SnareEngine(ctx, dest),
  clap:  (ctx, dest) => new ClapEngine(ctx, dest),
};

const ENGINE_SWAP_FADE_SECONDS = 0.02;

const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap'];

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
  analyser: AnalyserNode;
  trackGains: GainNode[];
  engines: SoundEngine[];
  scope: EffectScope;
}

// shallowRef so the computed bindings below (analyser, trackGains) actually
// re-evaluate when ensureAudio() flips this from null → AudioState. A plain
// `let` looks identical here but Vue can't observe the assignment, so the
// computeds would cache the initial null forever (oscilloscope stays flat).
const audioState = shallowRef<AudioState | null>(null);

function buildAudioState(): AudioState {
  const ctx = new AudioContext();

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-12, ctx.currentTime);
  compressor.knee.setValueAtTime(30, ctx.currentTime);
  compressor.ratio.setValueAtTime(12, ctx.currentTime);
  compressor.attack.setValueAtTime(0.003, ctx.currentTime);
  compressor.release.setValueAtTime(0.25, ctx.currentTime);

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.6, ctx.currentTime);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  compressor.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(ctx.destination);

  const trackGains: GainNode[] = Array(4).fill(null).map(() => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, ctx.currentTime);
    g.connect(compressor);
    return g;
  });

  const engines: SoundEngine[] = [];

  const syncTrackToEngine = (i: number) => {
    const state = trackStates[i];
    const targetType = state.engineType;
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

    engines[i].applyParams(state[targetType] as Record<string, any>);
  };

  const updateMixerGains = () => {
    const anySoloed = trackStates.some(ts => ts.mixer?.soloed);
    for (let i = 0; i < 4; i++) {
      const state = trackStates[i];
      let targetGain = 0;
      if (anySoloed) {
        targetGain = (state.mixer.soloed && !state.mixer.muted) ? state.mixer.volume : 0;
      } else {
        targetGain = !state.mixer.muted ? state.mixer.volume : 0;
      }
      trackGains[i].gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
    }
  };

  // Build engines + apply current trackStates (which may already carry pre-play knob edits).
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
        () => trackStates[i].engineType,
        () => syncTrackToEngine(i)
      );

      // Per-slice narrow watchers. Wrapping the getter in snapshot() does two
      // things: (a) Vue tracks every nested field as a dependency (no need
      // for `deep: true`); (b) each fire produces a fresh plain snapshot so
      // newVal/oldVal can be diffed — Vue would otherwise hand us the same
      // reactive proxy reference for both.
      for (const slice of ENGINE_SLICES) {
        watch(
          () => snapshot(trackStates[i][slice]),
          (newVal, oldVal) => {
            // Only apply if this slice is the active engine for the track.
            // Edits to a non-active slice are buffered until that engine
            // becomes active (the engineType watcher then full-syncs).
            if (trackStates[i].engineType !== slice) return;
            const changed = diffParams(newVal as Record<string, unknown>, oldVal as Record<string, unknown>);
            if (changed) engines[i].applyParams(changed);
          }
        );
      }

      // Mixer watcher stays deep: solo logic is global, so any change has to
      // recompute all 4 track gains via updateMixerGains.
      watch(
        () => trackStates[i].mixer,
        () => updateMixerGains(),
        { deep: true }
      );
    }
  });

  return { ctx, analyser, trackGains, engines, scope };
}

function ensureAudio(): AudioState {
  if (!audioState.value) {
    audioState.value = buildAudioState();
  }
  return audioState.value;
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
}

export function useSynth() {
  const currentStep = ref(-1);
  const activeTrackIndex = ref<number | null>(null); // null means 4-track overview

  const waveforms: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];

  function trackParam<K extends keyof TrackState, P extends keyof TrackState[K]>(
    engine: K, param: P, fallback: TrackState[K][P]
  ): WritableComputedRef<TrackState[K][P]> {
    return computed({
      get: () => activeTrackIndex.value !== null
        ? trackStates[activeTrackIndex.value][engine][param]
        : fallback,
      set: (val: TrackState[K][P]) => {
        if (activeTrackIndex.value !== null) {
          trackStates[activeTrackIndex.value][engine][param] = val;
        }
      }
    });
  }

  const engineType = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].engineType : 'synth' as EngineType,
    set: (val: EngineType) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].engineType = val;
    }
  });

  // --- Synth params ---
  const osc1Type = trackParam('synth', 'osc1Type', 'sawtooth' as OscillatorType);
  const osc2Type = trackParam('synth', 'osc2Type', 'sawtooth' as OscillatorType);
  const osc1Coarse = trackParam('synth', 'osc1Coarse', 0);
  const osc1Fine = trackParam('synth', 'osc1Fine', 0);
  const osc2Coarse = trackParam('synth', 'osc2Coarse', 0);
  const osc2Fine = trackParam('synth', 'osc2Fine', 0);
  const osc1Level = trackParam('synth', 'osc1Level', 0.5);
  const osc2Level = trackParam('synth', 'osc2Level', 0.5);
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

  const playMode = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].playMode : 'mono' as const,
    set: (val: 'mono' | 'chord') => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].playMode = val;
    }
  });

  const shortestActiveNoteDuration = computed<number | null>(() => {
    if (activeTrackIndex.value === null) return null;
    const track = sequencer.tracks[activeTrackIndex.value];
    if (!track) return null;
    const activeSteps = track.steps.filter(s => s.note !== null && !s.muted);
    if (activeSteps.length === 0) return null;
    const tickDuration = (60 / sequencer.bpm) / 4;
    const minTicks = Math.min(...activeSteps.map(s => s.length));
    return minTicks * tickDuration;
  });

  // Audio-derived bindings. `analyser` returns null until first ensureAudio()
  // so Visualizer renders a flat line during the pre-gesture window.
  const analyser: ComputedRef<AnalyserNode | null> = computed(() => audioState.value?.analyser ?? null);
  const trackGains: ComputedRef<GainNode[] | null> = computed(() => audioState.value?.trackGains ?? null);

  const togglePlay = () => {
    // First user gesture: this is where the AudioContext + engines + watchers
    // come alive. Doing it here (not at module load) eliminates Chrome's
    // "AudioContext was not allowed to start" warning.
    const state = ensureAudio();

    if (state.ctx.state === 'suspended') {
      state.ctx.resume();
    }

    if (sequencer.isPlaying) {
      sequencer.stop();
      currentStep.value = -1;
    } else {
      sequencer.start(state.ctx, (stepIndex, time) => {
        currentStep.value = stepIndex;

        for (let i = 0; i < 4; i++) {
          const step = sequencer.tracks[i].steps[stepIndex];
          if (step.note && !step.muted) {
            const engineTypeI = trackStates[i].engineType;
            if (engineTypeI === 'synth') {
              const currentPlayMode = trackStates[i].playMode || 'mono';
              const tickDuration = (60 / sequencer.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentPlayMode === 'chord') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                state.engines[i].trigger(freqs, duration, time, step.velocity);
              } else {
                const freq = noteToFreq(step.note, step.octave);
                state.engines[i].trigger(freq, duration, time, step.velocity);
              }
            } else {
              const freq = noteToFreq(step.note, step.octave);
              state.engines[i].trigger(freq, 0.15, time, step.velocity);
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
    return trackStates[index].engineType;
  };

  return {
    trackStates,
    analyser,
    trackGains,
    sequencer,
    activeTrackIndex,
    currentStep,
    waveforms,
    engineType,
    playMode,
    osc1Type,
    osc2Type,
    osc1Coarse,
    osc1Fine,
    osc2Coarse,
    osc2Fine,
    osc1Level,
    osc2Level,
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
