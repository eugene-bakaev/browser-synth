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
