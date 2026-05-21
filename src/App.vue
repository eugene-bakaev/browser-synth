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
        <OscillatorPanel
          v-model:osc1Type="osc1Type"
          v-model:osc1Coarse="osc1Coarse"
          v-model:osc1Fine="osc1Fine"
          v-model:osc2Type="osc2Type"
          v-model:osc2Coarse="osc2Coarse"
          v-model:osc2Fine="osc2Fine"
          :waveforms="waveforms"
        />

        <MixerPanel
          v-model:osc1Level="osc1Level"
          v-model:osc2Level="osc2Level"
        />

        <FilterPanel
          v-model:cutoff="filterCutoff"
          v-model:res="filterRes"
          v-model:envAmount="filterEnvAmount"
        />

        <EnvelopePanel
          :filterEnv="filterEnv"
          :ampEnv="ampEnv"
        />
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSynth } from './composables/useSynth';
import Tracker from './components/Tracker.vue';
import OscillatorPanel from './components/OscillatorPanel.vue';
import MixerPanel from './components/MixerPanel.vue';
import FilterPanel from './components/FilterPanel.vue';
import EnvelopePanel from './components/EnvelopePanel.vue';

const {
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
} = useSynth();
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
</style>
