import { ref, reactive, watch, computed } from 'vue';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine } from '../engine/KickEngine';
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

export type EngineType = 'synth' | 'kick';

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
}

// Persist the reactive states at module scope so they survive HMR/reload
const trackStates = reactive<TrackState[]>(Array(4).fill(null).map((_, index) => ({
  engineType: 'synth',
  synth: {
    osc1Type: 'sawtooth',
    osc2Type: 'sawtooth',
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
  }
})));

// Function to synchronize state back to individual engines
const syncTrackToEngine = (i: number) => {
  const state = trackStates[i];
  let engine = engines[i];
  
  const currentTypeIsSynth = engine instanceof SynthEngine;
  const targetTypeIsSynth = state.engineType === 'synth';
  
  if (currentTypeIsSynth !== targetTypeIsSynth) {
    engine.dispose();
    if (targetTypeIsSynth) {
      engine = new SynthEngine(sharedCtx);
    } else {
      engine = new KickEngine(sharedCtx);
    }
    engines[i] = engine;
  }
  
  if (engine instanceof SynthEngine) {
    engine.osc1.setWaveform(state.synth.osc1Type);
    engine.osc2.setWaveform(state.synth.osc2Type);
    engine.osc1.setCoarseTune(state.synth.osc1Coarse);
    engine.osc1.setFineTune(state.synth.osc1Fine);
    engine.osc2.setCoarseTune(state.synth.osc2Coarse);
    engine.osc2.setFineTune(state.synth.osc2Fine);
    engine.mixer.setChannelGain(1, state.synth.osc1Level);
    engine.mixer.setChannelGain(2, state.synth.osc2Level);
    
    engine.baseCutoff = state.synth.filterCutoff;
    engine.filterEnvAmount = state.synth.filterEnvAmount;
    
    if (engine.filter.inputs.resonance instanceof AudioParam) {
      engine.filter.inputs.resonance.setTargetAtTime(state.synth.filterRes, sharedCtx.currentTime, 0.01);
    }
    
    engine.filterEnv.a = state.synth.filterEnv.a;
    engine.filterEnv.d = state.synth.filterEnv.d;
    engine.filterEnv.s = state.synth.filterEnv.s;
    engine.filterEnv.r = state.synth.filterEnv.r;
    
    engine.ampEnv.a = state.synth.ampEnv.a;
    engine.ampEnv.d = state.synth.ampEnv.d;
    engine.ampEnv.s = state.synth.ampEnv.s;
    engine.ampEnv.r = state.synth.ampEnv.r;
  } else if (engine instanceof KickEngine) {
    engine.setTune(state.kick.tune);
    engine.setDecay(state.kick.decay);
    engine.setClick(state.kick.click);
  }
};

// Initialize engines
for (let i = 0; i < 4; i++) {
  syncTrackToEngine(i);
}

// Watch trackStates deeply and apply updates to corresponding engines
watch(trackStates, (newStates) => {
  for (let i = 0; i < 4; i++) {
    syncTrackToEngine(i);
  }
}, { deep: true });

export function useSynth() {
  const currentStep = ref(-1);
  const activeTrackIndex = ref<number | null>(null); // null means 4-track overview

  const waveforms: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];

  // Proximity values bound dynamically to the currently active track's settings
  const engineType = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].engineType : 'synth',
    set: (val: EngineType) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].engineType = val;
    }
  });

  const osc1Type = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc1Type : 'sawtooth',
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc1Type = val;
    }
  });

  const osc2Type = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc2Type : 'sawtooth',
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc2Type = val;
    }
  });

  const osc1Coarse = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc1Coarse : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc1Coarse = val;
    }
  });

  const osc1Fine = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc1Fine : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc1Fine = val;
    }
  });

  const osc2Coarse = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc2Coarse : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc2Coarse = val;
    }
  });

  const osc2Fine = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc2Fine : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc2Fine = val;
    }
  });

  const osc1Level = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc1Level : 0.5,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc1Level = val;
    }
  });

  const osc2Level = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.osc2Level : 0.5,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.osc2Level = val;
    }
  });

  const filterCutoff = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.filterCutoff : 2000,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.filterCutoff = val;
    }
  });

  const filterRes = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.filterRes : 1,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.filterRes = val;
    }
  });

  const filterEnvAmount = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].synth.filterEnvAmount : 3000,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].synth.filterEnvAmount = val;
    }
  });

  const filterEnv = computed(() => {
    if (activeTrackIndex.value === null) {
      return { a: 0.01, d: 0.2, s: 0.5, r: 0.5 };
    }
    return trackStates[activeTrackIndex.value].synth.filterEnv;
  });

  const ampEnv = computed(() => {
    if (activeTrackIndex.value === null) {
      return { a: 0.01, d: 0.2, s: 0.5, r: 0.5 };
    }
    return trackStates[activeTrackIndex.value].synth.ampEnv;
  });

  // Writable computed properties for Kick parameters
  const kickTune = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].kick.tune : 55,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].kick.tune = val;
    }
  });

  const kickDecay = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].kick.decay : 0.3,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].kick.decay = val;
    }
  });

  const kickClick = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].kick.click : 0.5,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].kick.click = val;
    }
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
    togglePlay,
    selectTrack,
    getTrackEngineType,
  };
}
