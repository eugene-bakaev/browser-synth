<template>
  <div class="rack-columns">
    <!-- Mono/Poly toggle -->
    <div class="synth-mode-selector">
      <button
        type="button"
        class="mode-btn"
        :class="{ active: params.mode === 'mono' }"
        @click="ks.set('mode', 'mono')"
      >
        MONO
      </button>
      <button
        type="button"
        class="mode-btn"
        :class="{ active: params.mode === 'poly' }"
        @click="ks.set('mode', 'poly')"
      >
        POLY
      </button>
    </div>

    <!-- Column 1: Oscillators & Mixer -->
    <div class="rack-column">
      <OscillatorPanel :params="params" :waveforms="waveforms" />
      <MixerPanel :params="params" />
    </div>

    <!-- Column 2: Filter & Filter Env -->
    <div class="rack-column">
      <FilterPanel :params="params" />
      <EnvelopePanel
        type="filter"
        :params="params"
        :shortestActiveNoteDuration="shortestActiveNoteDuration"
      />
    </div>

    <!-- Column 3: Amp Env & Oscilloscope Visualizer -->
    <div class="rack-column">
      <EnvelopePanel
        type="amp"
        :params="params"
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
import { useKnobSync } from '../sync/knobSync';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import type { EngineParamsMap } from '../project';

const ks = useKnobSync('synth');

defineProps<{
  params: EngineParamsMap['synth'];
  waveforms: OscillatorTypeLiteral[];
  shortestActiveNoteDuration: number | null;
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>

<style scoped>
/* Scoped layout styles for SynthPanel if any additional micro-spacing is needed.
   .synth-mode-selector styling is global (App.vue), shared with Synth2Panel. */
.rack-column > :not(:last-child) {
  margin-bottom: 15px;
}
</style>
