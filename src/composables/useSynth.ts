import { ref, reactive, watch } from 'vue';
import { SynthEngine } from '../engine/SynthEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';

// Keep a single instance of the audio context and sequencer to prevent multiple instances on HMR/reload
const engine = new SynthEngine();
const sequencer = reactive(new Sequencer());

export function useSynth() {
  const currentStep = ref(-1);

  // Waveforms & Tuning
  const waveforms: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];
  const osc1Type = ref<OscillatorType>('sawtooth');
  const osc2Type = ref<OscillatorType>('sawtooth');

  const osc1Coarse = ref(0);
  const osc1Fine = ref(0);
  const osc2Coarse = ref(0);
  const osc2Fine = ref(10); // Slight detune by default

  watch(osc1Type, (val) => engine.osc1.setWaveform(val));
  watch(osc2Type, (val) => engine.osc2.setWaveform(val));
  watch(osc1Coarse, (val) => engine.osc1.setCoarseTune(val));
  watch(osc1Fine, (val) => engine.osc1.setFineTune(val));
  watch(osc2Coarse, (val) => engine.osc2.setCoarseTune(val));
  watch(osc2Fine, (val) => engine.osc2.setFineTune(val));

  // Mixer
  const osc1Level = ref(0.5);
  const osc2Level = ref(0.5);

  watch(osc1Level, (val) => engine.mixer.setChannelGain(1, val));
  watch(osc2Level, (val) => engine.mixer.setChannelGain(2, val));

  // Filter
  const filterCutoff = ref(2000);
  const filterRes = ref(1);
  const filterEnvAmount = ref(3000);

  watch(filterCutoff, (val) => {
    engine.baseCutoff = val;
  });

  watch(filterEnvAmount, (val) => {
    engine.filterEnvAmount = val;
  });

  watch(filterRes, (val) => {
    if (engine.filter.inputs.resonance instanceof AudioParam) {
      engine.filter.inputs.resonance.setTargetAtTime(val, engine.ctx.currentTime, 0.05);
    }
  });

  // Envelopes Reactivity (since engine itself is not reactive to avoid AudioContext proxy bugs)
  const filterEnv = reactive({
    a: engine.filterEnv.a,
    d: engine.filterEnv.d,
    s: engine.filterEnv.s,
    r: engine.filterEnv.r,
  });

  const ampEnv = reactive({
    a: engine.ampEnv.a,
    d: engine.ampEnv.d,
    s: engine.ampEnv.s,
    r: engine.ampEnv.r,
  });

  watch(filterEnv, (newVal) => {
    engine.filterEnv.a = newVal.a;
    engine.filterEnv.d = newVal.d;
    engine.filterEnv.s = newVal.s;
    engine.filterEnv.r = newVal.r;
  }, { deep: true });

  watch(ampEnv, (newVal) => {
    engine.ampEnv.a = newVal.a;
    engine.ampEnv.d = newVal.d;
    engine.ampEnv.s = newVal.s;
    engine.ampEnv.r = newVal.r;
  }, { deep: true });

  // Initialize default values to engine
  engine.osc1.setWaveform(osc1Type.value);
  engine.osc2.setWaveform(osc2Type.value);
  engine.osc1.setFineTune(osc1Fine.value);
  engine.osc2.setFineTune(osc2Fine.value);
  engine.mixer.setChannelGain(1, osc1Level.value);
  engine.mixer.setChannelGain(2, osc2Level.value);

  const togglePlay = () => {
    if (engine.ctx.state === 'suspended') {
      engine.ctx.resume();
    }

    if (sequencer.isPlaying) {
      sequencer.stop();
      currentStep.value = -1;
    } else {
      sequencer.start(engine.ctx, (step, time) => {
        currentStep.value = (currentStep.value + 1) % 16; 
        
        if (step.note) {
          const freq = noteToFreq(step.note, step.octave);
          const tickDuration = (60 / sequencer.bpm) / 4;
          const duration = step.length * tickDuration;
          engine.trigger(freq, duration, time);
        }
      });
    }
  };

  return {
    engine,
    sequencer,
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
  };
}
