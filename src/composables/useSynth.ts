import { ref, reactive, watch, computed } from 'vue';
import { SynthEngine } from '../engine/SynthEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';

// Instantiate a single shared AudioContext and 4 engines to ensure perfect sync
const sharedCtx = new AudioContext();
const engines = [
  new SynthEngine(sharedCtx),
  new SynthEngine(sharedCtx),
  new SynthEngine(sharedCtx),
  new SynthEngine(sharedCtx),
];
const sequencer = reactive(new Sequencer());

interface TrackState {
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
}

// Persist the reactive states at module scope so they survive HMR/reload
const trackStates = reactive<TrackState[]>(Array(4).fill(null).map((_, index) => ({
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
})));

// Function to synchronize state back to individual engines
const syncTrackToEngine = (i: number) => {
  const state = trackStates[i];
  const engine = engines[i];
  
  engine.osc1.setWaveform(state.osc1Type);
  engine.osc2.setWaveform(state.osc2Type);
  engine.osc1.setCoarseTune(state.osc1Coarse);
  engine.osc1.setFineTune(state.osc1Fine);
  engine.osc2.setCoarseTune(state.osc2Coarse);
  engine.osc2.setFineTune(state.osc2Fine);
  engine.mixer.setChannelGain(1, state.osc1Level);
  engine.mixer.setChannelGain(2, state.osc2Level);
  
  engine.baseCutoff = state.filterCutoff;
  engine.filterEnvAmount = state.filterEnvAmount;
  
  if (engine.filter.inputs.resonance instanceof AudioParam) {
    engine.filter.inputs.resonance.setTargetAtTime(state.filterRes, sharedCtx.currentTime, 0.01);
  }
  
  engine.filterEnv.a = state.filterEnv.a;
  engine.filterEnv.d = state.filterEnv.d;
  engine.filterEnv.s = state.filterEnv.s;
  engine.filterEnv.r = state.filterEnv.r;
  
  engine.ampEnv.a = state.ampEnv.a;
  engine.ampEnv.d = state.ampEnv.d;
  engine.ampEnv.s = state.ampEnv.s;
  engine.ampEnv.r = state.ampEnv.r;
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
  const osc1Type = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc1Type : 'sawtooth',
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc1Type = val;
    }
  });

  const osc2Type = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc2Type : 'sawtooth',
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc2Type = val;
    }
  });

  const osc1Coarse = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc1Coarse : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc1Coarse = val;
    }
  });

  const osc1Fine = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc1Fine : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc1Fine = val;
    }
  });

  const osc2Coarse = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc2Coarse : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc2Coarse = val;
    }
  });

  const osc2Fine = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc2Fine : 0,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc2Fine = val;
    }
  });

  const osc1Level = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc1Level : 0.5,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc1Level = val;
    }
  });

  const osc2Level = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].osc2Level : 0.5,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].osc2Level = val;
    }
  });

  const filterCutoff = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].filterCutoff : 2000,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].filterCutoff = val;
    }
  });

  const filterRes = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].filterRes : 1,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].filterRes = val;
    }
  });

  const filterEnvAmount = computed({
    get: () => activeTrackIndex.value !== null ? trackStates[activeTrackIndex.value].filterEnvAmount : 3000,
    set: (val) => {
      if (activeTrackIndex.value !== null) trackStates[activeTrackIndex.value].filterEnvAmount = val;
    }
  });

  // Dynamic references to the active track's ADSR structures
  const filterEnv = computed(() => {
    if (activeTrackIndex.value === null) {
      return { a: 0.01, d: 0.2, s: 0.5, r: 0.5 };
    }
    return trackStates[activeTrackIndex.value].filterEnv;
  });

  const ampEnv = computed(() => {
    if (activeTrackIndex.value === null) {
      return { a: 0.01, d: 0.2, s: 0.5, r: 0.5 };
    }
    return trackStates[activeTrackIndex.value].ampEnv;
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

  return {
    engines,
    sequencer,
    activeTrackIndex,
    currentStep,
    waveforms,
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
    togglePlay,
    selectTrack,
  };
}
