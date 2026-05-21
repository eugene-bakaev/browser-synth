import { ref, reactive, watch, computed, type WritableComputedRef } from 'vue';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';
import { HatEngine } from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine } from '../engine/ClapEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';

// Instantiate a single shared AudioContext and 4 engines to ensure perfect sync
const sharedCtx = new AudioContext();
const engines: SoundEngine[] = [
  new SynthEngine(sharedCtx),
  new SynthEngine(sharedCtx),
  new SynthEngine(sharedCtx),
  new SynthEngine(sharedCtx),
];
const sequencer = reactive(new Sequencer());

export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

// Factory map: engineType -> constructor. No instanceof needed.
const engineFactories: Record<EngineType, (ctx: AudioContext) => SoundEngine> = {
  synth: (ctx) => new SynthEngine(ctx),
  kick: (ctx) => new KickEngine(ctx),
  hat: (ctx) => new HatEngine(ctx),
  snare: (ctx) => new SnareEngine(ctx),
  clap: (ctx) => new ClapEngine(ctx),
};

export interface TrackState {
  engineType: EngineType;
  synth: {
    osc1Type: OscillatorType;
    osc2Type: OscillatorType;
    osc1Coarse: number;
    osc1Fine: number;
    osc2Coarse: number;
    osc2Fine: number;
    osc1Level: number;
    osc2Level: number;
    filterCutoff: number;
    filterRes: number;
    filterEnvAmount: number;
    filterEnv: { a: number; d: number; s: number; r: number };
    ampEnv: { a: number; d: number; s: number; r: number };
  };
  kick: {
    tune: number;  // Hz (40 - 120)
    decay: number; // seconds (0.05 - 1.5)
    click: number; // ratio (0.0 - 1.0)
  };
  hat: {
    decay: number;    // seconds (0.02 - 0.6)
    tone: number;     // Hz (3000 - 14000)
    metallic: number; // ratio (0.0 - 1.0)
  };
  snare: {
    tune: number;   // Hz (100 - 250)
    decay: number;  // seconds (0.05 - 0.8)
    snappy: number; // ratio (0.0 - 1.0)
  };
  clap: {
    decay: number;   // seconds (0.05 - 0.8)
    tone: number;    // Hz (500 - 3000)
    sloppy: number;  // seconds (0.005 - 0.03)
  };
}

// Persist the reactive states at module scope so they survive HMR/reload
const trackStates = reactive<TrackState[]>(Array(4).fill(null).map((_, index) => ({
  engineType: 'synth' as EngineType,
  synth: {
    osc1Type: 'sawtooth' as OscillatorType,
    osc2Type: 'sawtooth' as OscillatorType,
    osc1Coarse: 0,
    osc1Fine: 0,
    osc2Coarse: 0,
    osc2Fine: index === 0 ? 10 : 0, // default detune on first track
    osc1Level: 0.5,
    osc2Level: 0.5,
    filterCutoff: 2000,
    filterRes: 1,
    filterEnvAmount: 3000,
    filterEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
    ampEnv: { a: 0.01, d: 0.2, s: 0.5, r: 0.5 },
  },
  kick: {
    tune: 55,
    decay: 0.3,
    click: 0.5,
  },
  hat: {
    decay: 0.15,
    tone: 8000,
    metallic: 0.5,
  },
  snare: {
    tune: 180,
    decay: 0.25,
    snappy: 0.5,
  },
  clap: {
    decay: 0.25,
    tone: 1000,
    sloppy: 0.015,
  }
})));

// Synchronize state to engine — uses engineType discriminator + applyParams(), no instanceof.
const syncTrackToEngine = (i: number) => {
  const state = trackStates[i];
  let engine = engines[i];
  const targetType = state.engineType;

  // Swap engine if type changed
  if (engine.engineType !== targetType) {
    engine.dispose();
    engine = engineFactories[targetType](sharedCtx);
    engines[i] = engine;
  }

  // Apply params polymorphically — each engine knows how to interpret its own params
  engine.applyParams(state[targetType] as Record<string, any>);
};

// Initialize engines
for (let i = 0; i < 4; i++) {
  syncTrackToEngine(i);
}

// Watch trackStates deeply and apply updates to corresponding engines
watch(trackStates, () => {
  for (let i = 0; i < 4; i++) {
    syncTrackToEngine(i);
  }
}, { deep: true });

export function useSynth() {
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
  const filterEnvAmount = trackParam('synth', 'filterEnvAmount', 3000);
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
          if (step.note) {
            const freq = noteToFreq(step.note, step.octave);
            const tickDuration = (60 / sequencer.bpm) / 4;
            const duration = step.length * tickDuration;
            engines[i].trigger(freq, duration, time);
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
    engines,
    sequencer,
    activeTrackIndex,
    currentStep,
    waveforms,
    engineType,
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
