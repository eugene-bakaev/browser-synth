<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls -->
    <div class="rack-column">
      <div class="module-group kick-panel">
        <h3>Kick Machine</h3>
        <div class="knob-row">
          <Knob label="Tune" :min="40" :max="120" :step="1" :defaultValue="DEFAULTS.tune" format="hz" v-model="tune" />
          <Knob label="Decay" :min="0.05" :max="1.5" :step="0.01" :defaultValue="DEFAULTS.decay" format="ms" v-model="decay" />
          <Knob label="Click" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.click" format="percent" v-model="click" />
        </div>
      </div>
    </div>
    
    <!-- Column 2: Visualizer -->
    <div class="rack-column">
      <Visualizer :analyser="analyser" :color="color" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { KickEngine } from '../engine/KickEngine';

const DEFAULTS = KickEngine.DEFAULT_PARAMS;

defineProps<{
  analyser: AnalyserNode | null;
  color: string;
}>();

const tune = defineModel<number>('tune', { required: true });
const decay = defineModel<number>('decay', { required: true });
const click = defineModel<number>('click', { required: true });
</script>


