<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls -->
    <div class="rack-column">
      <div class="module-group hat-panel">
        <h3>Hat Machine</h3>
        <div class="knob-row">
          <Knob label="Decay" :min="0.02" :max="0.6" :step="0.01" format="ms" v-model="decay" />
          <Knob label="Tone" :min="3000" :max="14000" :step="100" format="hz" v-model="tone" />
          <Knob label="Metallic" :min="0" :max="1" :step="0.01" format="percent" v-model="metallic" />
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

defineProps<{
  analyser: AnalyserNode | null;
  color: string;
}>();

const decay = defineModel<number>('decay', { required: true });
const tone = defineModel<number>('tone', { required: true });
const metallic = defineModel<number>('metallic', { required: true });
</script>


