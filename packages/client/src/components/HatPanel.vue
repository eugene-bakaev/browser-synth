<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls -->
    <div class="rack-column">
      <div class="module-group hat-panel">
        <h3>Hat Machine</h3>
        <div class="knob-row">
          <Knob label="Decay" :min="0.02" :max="0.6" :step="0.01" :defaultValue="DEFAULTS.decay" format="ms" v-model="decay" :syncPath="ks.pathFor('decay')" @gesture-end="ks.end('decay')" />
          <Knob label="Tone" :min="3000" :max="14000" :step="100" :defaultValue="DEFAULTS.tone" format="hz" v-model="tone" :syncPath="ks.pathFor('tone')" @gesture-end="ks.end('tone')" />
          <Knob label="Metallic" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.metallic" format="percent" v-model="metallic" :syncPath="ks.pathFor('metallic')" @gesture-end="ks.end('metallic')" />
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
import { HatEngine } from '../engine/HatEngine';
import { useKnobSync } from '../sync/knobSync';

const DEFAULTS = HatEngine.DEFAULT_PARAMS;
const ks = useKnobSync('hat');

defineProps<{
  analyser: AnalyserNode | null;
  color: string;
}>();

const decay = defineModel<number>('decay', { required: true });
const tone = defineModel<number>('tone', { required: true });
const metallic = defineModel<number>('metallic', { required: true });
</script>


