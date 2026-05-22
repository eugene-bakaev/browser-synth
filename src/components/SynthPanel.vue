<template>
  <div class="rack-columns">
    <!-- Column 1: Oscillators & Mixer -->
    <div class="rack-column">
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
      />
    </div>

    <!-- Column 3: Amp Env & Oscilloscope Visualizer -->
    <div class="rack-column">
      <EnvelopePanel
        type="amp"
        :ampEnv="ampEnv"
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
  analyser: AnalyserNode | null;
  color: string;
}>();

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
</script>

<style scoped>
/* Scoped layout styles for SynthPanel if any additional micro-spacing is needed */
.rack-column > :not(:last-child) {
  margin-bottom: 15px;
}
</style>
