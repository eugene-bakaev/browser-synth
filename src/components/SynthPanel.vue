<template>
  <div class="rack-columns">
    <!-- Mono/Poly toggle -->
    <div class="synth-mode-selector">
      <button
        type="button"
        class="mode-btn"
        :class="{ active: mode === 'mono' }"
        @click="mode = 'mono'"
      >
        MONO
      </button>
      <button
        type="button"
        class="mode-btn"
        :class="{ active: mode === 'poly' }"
        @click="mode = 'poly'"
      >
        POLY
      </button>
    </div>

    <!-- Column 1: Oscillators & Mixer -->
    <div class="rack-column">
      <OscillatorPanel
        v-model:oscMode="oscMode"
        v-model:osc1Type="osc1Type"
        v-model:osc1Coarse="osc1Coarse"
        v-model:osc1Fine="osc1Fine"
        v-model:osc1Phase="osc1Phase"
        v-model:osc2Type="osc2Type"
        v-model:osc2Coarse="osc2Coarse"
        v-model:osc2Fine="osc2Fine"
        v-model:osc2Phase="osc2Phase"
        :waveforms="waveforms"
      />
      <MixerPanel
        v-model:osc1Level="osc1Level"
        v-model:osc2Level="osc2Level"
      />
    </div>

    <!-- Column 2: Filter & Filter Env -->
    <div class="rack-column">
      <FilterPanel
        v-model:cutoff="filterCutoff"
        v-model:res="filterRes"
        v-model:envAmount="filterEnvAmount"
      />
      <EnvelopePanel
        type="filter"
        :filterEnv="filterEnv"
        :shortestActiveNoteDuration="shortestActiveNoteDuration"
      />
    </div>

    <!-- Column 3: Amp Env & Oscilloscope Visualizer -->
    <div class="rack-column">
      <EnvelopePanel
        type="amp"
        :ampEnv="ampEnv"
        :shortestActiveNoteDuration="shortestActiveNoteDuration"
      />
      <Visualizer
        :analyser="analyser"
        :color="color"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import OscillatorPanel from './OscillatorPanel.vue';
import MixerPanel from './MixerPanel.vue';
import FilterPanel from './FilterPanel.vue';
import EnvelopePanel from './EnvelopePanel.vue';
import Visualizer from './Visualizer.vue';

defineProps<{
  waveforms: OscillatorType[];
  filterEnv: { a: number; d: number; s: number; r: number };
  ampEnv: { a: number; d: number; s: number; r: number };
  shortestActiveNoteDuration: number | null;
  analyser: AnalyserNode | null;
  color: string;
}>();

const mode = defineModel<'mono' | 'poly'>('mode', { required: true });
const osc1Type = defineModel<OscillatorType>('osc1Type', { required: true });
const osc1Coarse = defineModel<number>('osc1Coarse', { required: true });
const osc1Fine = defineModel<number>('osc1Fine', { required: true });
const osc2Type = defineModel<OscillatorType>('osc2Type', { required: true });
const osc2Coarse = defineModel<number>('osc2Coarse', { required: true });
const osc2Fine = defineModel<number>('osc2Fine', { required: true });
const osc1Level = defineModel<number>('osc1Level', { required: true });
const osc2Level = defineModel<number>('osc2Level', { required: true });
const filterCutoff = defineModel<number>('filterCutoff', { required: true });
const filterRes = defineModel<number>('filterRes', { required: true });
const filterEnvAmount = defineModel<number>('filterEnvAmount', { required: true });
const oscMode = defineModel<'free-run' | 'phase-offset' | 'retrigger-recreate' | 'retrigger-wavetable'>('oscMode', { required: true });
const osc1Phase = defineModel<number>('osc1Phase', { required: true });
const osc2Phase = defineModel<number>('osc2Phase', { required: true });
</script>

<style scoped>
/* Scoped layout styles for SynthPanel if any additional micro-spacing is needed */
.rack-column > :not(:last-child) {
  margin-bottom: 15px;
}

.synth-mode-selector {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-bottom: 5px;
}
.synth-mode-selector .mode-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 6px 12px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.synth-mode-selector .mode-btn:hover {
  color: #aaa;
  border-color: #444;
}
.synth-mode-selector .mode-btn.active {
  background: #222;
  color: #fff;
  border-color: #555;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}
</style>
