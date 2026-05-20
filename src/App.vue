<template>
  <div class="synth-container">
    <header>
      <h1>Fiddle Synth</h1>
      <div class="transport">
        <button @click="togglePlay" :class="{ playing: sequencer.isPlaying }">
          {{ sequencer.isPlaying ? 'STOP' : 'PLAY' }}
        </button>
        <div class="bpm">
          <label>BPM</label>
          <input type="number" v-model.number="sequencer.bpm" min="40" max="240">
        </div>
      </div>
    </header>

    <div class="main-content">
      <section class="sequencer-section">
        <Tracker :steps="sequencer.steps" :currentStep="currentStep" />
      </section>

      <section class="engine-section">
        <div class="module-group">
          <h3>Oscillators</h3>
          <div class="osc-row">
            <div class="osc-unit">
              <h4>OSC 1</h4>
              <select v-model="osc1Type">
                <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
              </select>
              <Knob label="Coarse" :min="-3" :max="3" :step="1" v-model="osc1Coarse" />
              <Knob label="Fine" :min="-100" :max="100" :step="1" v-model="osc1Fine" />
            </div>
            <div class="osc-unit">
              <h4>OSC 2</h4>
              <select v-model="osc2Type">
                <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
              </select>
              <Knob label="Coarse" :min="-3" :max="3" :step="1" v-model="osc2Coarse" />
              <Knob label="Fine" :min="-100" :max="100" :step="1" v-model="osc2Fine" />
            </div>
          </div>
        </div>

        <div class="module-group">
          <h3>Mixer</h3>
          <div class="knob-row">
            <Knob label="OSC 1 Level" :min="0" :max="1" :step="0.01" v-model="osc1Level" />
            <Knob label="OSC 2 Level" :min="0" :max="1" :step="0.01" v-model="osc2Level" />
          </div>
        </div>

        <div class="module-group">
          <h3>Filter</h3>
          <div class="knob-row">
            <Knob label="Cutoff" :min="20" :max="10000" :step="1" v-model="filterCutoff" />
            <Knob label="Res" :min="0" :max="20" :step="0.1" v-model="filterRes" />
            <Knob label="Env Amt" :min="0" :max="5000" :step="10" v-model="filterEnvAmount" />
          </div>
        </div>

        <div class="env-row">
          <div class="module-group">
            <h3>Filter Env</h3>
            <div class="knob-row">
              <Knob label="A" :min="0" :max="2" :step="0.01" v-model="engine.filterEnv.a" />
              <Knob label="D" :min="0" :max="2" :step="0.01" v-model="engine.filterEnv.d" />
              <Knob label="S" :min="0" :max="1" :step="0.01" v-model="engine.filterEnv.s" />
              <Knob label="R" :min="0" :max="5" :step="0.01" v-model="engine.filterEnv.r" />
            </div>
          </div>

          <div class="module-group">
            <h3>Amp Env</h3>
            <div class="knob-row">
              <Knob label="A" :min="0" :max="2" :step="0.01" v-model="engine.ampEnv.a" />
              <Knob label="D" :min="0" :max="2" :step="0.01" v-model="engine.ampEnv.d" />
              <Knob label="S" :min="0" :max="1" :step="0.01" v-model="engine.ampEnv.s" />
              <Knob label="R" :min="0" :max="5" :step="0.01" v-model="engine.ampEnv.r" />
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { SynthEngine } from './engine/SynthEngine';
import { Sequencer } from './sequencer/Sequencer';
import { noteToFreq } from './utils/notes';
import Tracker from './components/Tracker.vue';
import Knob from './components/Knob.vue';

const engine = new SynthEngine();
const sequencer = reactive(new Sequencer());
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

// Initialize default values to engine
engine.osc1.setWaveform(osc1Type.value);
engine.osc2.setWaveform(osc2Type.value);
engine.osc1.setFineTune(osc1Fine.value);
engine.osc2.setFineTune(osc2Fine.value);
engine.mixer.setChannelGain(1, osc1Level.value);
engine.mixer.setChannelGain(2, osc2Level.value);

const togglePlay = () => {
  // Browsers require AudioContext to be resumed from a user gesture!
  if (engine.ctx.state === 'suspended') {
    engine.ctx.resume();
  }

  if (sequencer.isPlaying) {
    sequencer.stop();
    currentStep.value = -1;
  } else {
    sequencer.start(engine.ctx, (step, time) => {
      // The visual step update might run slightly ahead of audio, but that's standard for Web Audio lookahead
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
</script>

<style>
body { margin: 0; background: #1a1a1a; color: #eee; font-family: sans-serif; }
.synth-container { max-width: 1200px; margin: 0 auto; padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; }
.main-content { display: flex; gap: 30px; flex: 1; align-items: flex-start; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-shrink: 0; }
.transport { display: flex; gap: 20px; align-items: center; }
button { padding: 10px 20px; background: #444; color: #fff; border: none; cursor: pointer; font-weight: bold; }
button.playing { background: #0f0; color: #000; }
.engine-section { flex: 1; display: flex; flex-direction: column; gap: 15px; }
.module-group { background: #222; padding: 15px; border-radius: 8px; }
h3 { margin-top: 0; color: #888; border-bottom: 1px solid #333; padding-bottom: 5px; }
.osc-row { display: flex; gap: 20px; }
.osc-unit { flex: 1; background: #333; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; }
.osc-unit h4 { margin: 0 0 10px 0; font-size: 0.8rem; color: #888; }
.knob-row { display: flex; gap: 15px; flex-wrap: wrap; }
.env-row { display: flex; gap: 20px; }
.env-row .module-group { flex: 1; margin-top: 0; }
select { background: #000; color: #fff; border: 1px solid #444; padding: 5px; margin-bottom: 10px; }
</style>
