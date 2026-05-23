<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls -->
    <div class="rack-column">
      <div class="module-group snare-panel">
        <h3>Snare Machine</h3>
        <div class="knob-row">
          <Knob label="Tune" :min="100" :max="250" :step="1" :defaultValue="DEFAULTS.tune" format="hz" v-model="tune" />
          <Knob label="Decay" :min="0.05" :max="0.8" :step="0.01" :defaultValue="DEFAULTS.decay" format="ms" v-model="decay" />
          <Knob label="Snappy" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.snappy" format="percent" v-model="snappy" />
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
import { SnareEngine } from '../engine/SnareEngine';

const DEFAULTS = SnareEngine.DEFAULT_PARAMS;

defineProps<{
  analyser: AnalyserNode | null;
  color: string;
}>();

const tune = defineModel<number>('tune', { required: true });
const decay = defineModel<number>('decay', { required: true });
const snappy = defineModel<number>('snappy', { required: true });
</script>


