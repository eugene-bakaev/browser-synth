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

    <section class="sequencer-section">
      <Tracker :steps="sequencer.steps" :currentStep="currentStep" />
    </section>

    <section class="engine-section">
      <div class="module-group">
        <h3>Filter</h3>
        <Knob label="Cutoff" :min="20" :max="10000" :step="1" v-model="filterCutoff" />
        <Knob label="Res" :min="0" :max="20" :step="0.1" v-model="filterRes" />
      </div>

      <div class="module-group">
        <h3>Amp Env</h3>
        <Knob label="A" :min="0" :max="2" :step="0.01" v-model="engine.ampEnv.a" />
        <Knob label="D" :min="0" :max="2" :step="0.01" v-model="engine.ampEnv.d" />
        <Knob label="S" :min="0" :max="1" :step="0.01" v-model="engine.ampEnv.s" />
        <Knob label="R" :min="0" :max="5" :step="0.01" v-model="engine.ampEnv.r" />
      </div>
    </section>
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

// Bridge reactive state to engine params
const filterCutoff = ref(2000);
const filterRes = ref(1);

watch(filterCutoff, (val) => {
  if (engine.filter.inputs.cutoff instanceof AudioParam) {
    engine.filter.inputs.cutoff.setTargetAtTime(val, engine.ctx.currentTime, 0.05);
  }
});

watch(filterRes, (val) => {
  if (engine.filter.inputs.resonance instanceof AudioParam) {
    engine.filter.inputs.resonance.setTargetAtTime(val, engine.ctx.currentTime, 0.05);
  }
});

const togglePlay = () => {
  if (sequencer.isPlaying) {
    sequencer.stop();
    currentStep.value = -1;
  } else {
    sequencer.start((step) => {
      currentStep.value = (currentStep.value + 1) % 16;
      if (step.note) {
        const freq = noteToFreq(step.note, step.octave);
        engine.trigger(freq, 0.1);
      }
    });
  }
};
</script>

<style>
body { margin: 0; background: #1a1a1a; color: #eee; font-family: sans-serif; }
.synth-container { max-width: 800px; margin: 0 auto; padding: 20px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.transport { display: flex; gap: 20px; align-items: center; }
button { padding: 10px 20px; background: #444; color: #fff; border: none; cursor: pointer; }
button.playing { background: #0f0; color: #000; }
.module-group { background: #222; padding: 15px; border-radius: 8px; margin-top: 20px; }
h3 { margin-top: 0; color: #888; border-bottom: 1px solid #333; }
</style>
