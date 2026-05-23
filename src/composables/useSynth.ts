import { ref, reactive, watch, computed, type WritableComputedRef } from 'vue';
import { SoundEngine } from '../engine/types';
import { SynthEngine, type SynthEngineParams } from '../engine/SynthEngine';
import { KickEngine, type KickEngineParams } from '../engine/KickEngine';
import { HatEngine, type HatEngineParams } from '../engine/HatEngine';
import { SnareEngine, type SnareEngineParams } from '../engine/SnareEngine';
import { ClapEngine, type ClapEngineParams } from '../engine/ClapEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';

// Instantiate a single shared AudioContext and 4 engines to ensure perfect sync
const sharedCtx = new AudioContext();

// Create a master dynamics compressor to prevent digital clipping/crackling
const compressor = sharedCtx.createDynamicsCompressor();
compressor.threshold.setValueAtTime(-12, sharedCtx.currentTime); // threshold in dB
compressor.knee.setValueAtTime(30, sharedCtx.currentTime);       // knee in dB
compressor.ratio.setValueAtTime(12, sharedCtx.currentTime);      // compression ratio
compressor.attack.setValueAtTime(0.003, sharedCtx.currentTime);  // attack in seconds
compressor.release.setValueAtTime(0.25, sharedCtx.currentTime);  // release in seconds

// Create a master gain node to provide headroom
const masterGain = sharedCtx.createGain();
masterGain.gain.setValueAtTime(0.6, sharedCtx.currentTime);

// Create a master AnalyserNode to capture output from all active engines
const analyser = sharedCtx.createAnalyser();
analyser.fftSize = 1024;

// Route master chain
compressor.connect(masterGain);
masterGain.connect(analyser);
analyser.connect(sharedCtx.destination);

// Create track gains for mixing/mute/solo (routed to the compressor)
export const trackGains: GainNode[] = Array(4).fill(null).map(() => {
  const g = sharedCtx.createGain();
  g.gain.setValueAtTime(0.8, sharedCtx.currentTime); // default volume is 0.8
  g.connect(compressor);
  return g;
});

const sequencer = reactive(new Sequencer());

export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

// Factory map: engineType -> constructor. Connect engines to their track gain node.
const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth: (ctx, dest) => new SynthEngine(ctx, dest),
  kick: (ctx, dest) => new KickEngine(ctx, dest),
  hat: (ctx, dest) => new HatEngine(ctx, dest),
  snare: (ctx, dest) => new SnareEngine(ctx, dest),
  clap: (ctx, dest) => new ClapEngine(ctx, dest),
};

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

const DEFAULT_MIXER_STATE: MixerState = {
  volume: 0.8,
  muted: false,
  soloed: false,
};

// Persist the reactive states at module scope so they survive HMR/reload.
// Each per-engine slice deep-clones the engine's DEFAULT_PARAMS so the tracks
// don't share nested objects (e.g. mutating track 0's filterEnv must not bleed
// into track 1).
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

// Engines are lazily built on first sync via the factory map so we don't
// instantiate engine types the user may immediately swap away from.
const engines: SoundEngine[] = [];

// Calculate and apply target gains smoothly to prevent clicks/pops
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
    // Smooth transitions using setTargetAtTime
    trackGains[i].gain.setTargetAtTime(targetGain, sharedCtx.currentTime, 0.015);
  }
};

// Synchronize state to engine — uses engineType discriminator + applyParams(), no instanceof.
const ENGINE_SWAP_FADE_SECONDS = 0.02;
const syncTrackToEngine = (i: number) => {
  const state = trackStates[i];
  const targetType = state.engineType;
  const existing = engines[i];

  if (!existing || existing.engineType !== targetType) {
    if (existing) {
      // Fade trackGain to 0 over ~20ms so dispose()'s synchronous osc.stop() doesn't click.
      // The new engine connects to the same trackGain; updateMixerGains restores it after.
      trackGains[i].gain.setTargetAtTime(0, sharedCtx.currentTime, ENGINE_SWAP_FADE_SECONDS / 3);
      const oldEngine = existing;
      setTimeout(() => {
        oldEngine.dispose();
        updateMixerGains();
      }, (ENGINE_SWAP_FADE_SECONDS * 1000) + 5);
    }
    engines[i] = engineFactories[targetType](sharedCtx, trackGains[i]);
  }

  // Apply params polymorphically — each engine knows how to interpret its own params
  engines[i].applyParams(state[targetType] as Record<string, any>);
};

// Initialize engines and mixer gains
for (let i = 0; i < 4; i++) {
  syncTrackToEngine(i);
}
updateMixerGains();

// Watch engine type and specific parameters to trigger sync
for (let i = 0; i < 4; i++) {
  watch(
    () => [
      trackStates[i].engineType,
      trackStates[i].synth,
      trackStates[i].kick,
      trackStates[i].hat,
      trackStates[i].snare,
      trackStates[i].clap
    ],
    () => {
      syncTrackToEngine(i);
    },
    { deep: true }
  );
}

// Watch mixer parameters separately to update gains
for (let i = 0; i < 4; i++) {
  watch(
    () => trackStates[i].mixer,
    () => {
      updateMixerGains();
    },
    { deep: true }
  );
}

let useSynthInvocationCount = 0;

export function useSynth() {
  useSynthInvocationCount += 1;
  if (useSynthInvocationCount > 1) {
    // Audio context, engines, sequencer, and watchers are module-scoped singletons.
    // A second call returns fresh local refs (currentStep, activeTrackIndex) but
    // shares all audio/sequencer state — almost always a wiring bug.
    console.warn(
      `[useSynth] called ${useSynthInvocationCount} times — audio state is module-scoped and shared. ` +
      `If this is intentional (e.g. multiple views), be aware that local UI refs are NOT shared.`
    );
  }

  const currentStep = ref(-1);
  const activeTrackIndex = ref<number | null>(null); // null means 4-track overview

  const waveforms: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];

  // --- Generic helper to create writable computed refs bound to the active track ---
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

  // Engine type selector (slightly different shape — lives on TrackState directly)
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

  // Duration (in seconds) of the shortest non-muted note on the active track.
  // Used to warn the user when their envelope A+D exceeds the actual note length —
  // i.e. when the envelope is being audibly truncated by the next step.
  // Returns null when no notes are active (no warning needed).
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

  const togglePlay = () => {
    if (sharedCtx.state === 'suspended') {
      sharedCtx.resume();
    }

    if (sequencer.isPlaying) {
      sequencer.stop();
      currentStep.value = -1;
    } else {
      sequencer.start(sharedCtx, (stepIndex, time) => {
        currentStep.value = stepIndex;
        
        // Trigger all tracks in parallel
        for (let i = 0; i < 4; i++) {
          const step = sequencer.tracks[i].steps[stepIndex];
          if (step.note && !step.muted) {
            const engineType = trackStates[i].engineType;
            if (engineType === 'synth') {
              const currentPlayMode = trackStates[i].playMode || 'mono';
              const tickDuration = (60 / sequencer.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentPlayMode === 'chord') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                engines[i].trigger(freqs, duration, time, step.velocity);
              } else {
                const freq = noteToFreq(step.note, step.octave);
                engines[i].trigger(freq, duration, time, step.velocity);
              }
            } else {
              // Drum engine: trigger with standard freq, duration 0.15s, and pass step.velocity
              const freq = noteToFreq(step.note, step.octave);
              engines[i].trigger(freq, 0.15, time, step.velocity);
            }
          }
        }
      });
    }
  };

  const selectTrack = (index: number | null) => {
    activeTrackIndex.value = index;
  };

  // Helper to check if a specific track is using a specific engine
  const getTrackEngineType = (index: number): EngineType => {
    return trackStates[index].engineType;
  };

  return {
    trackStates,
    analyser,
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
  };
}
