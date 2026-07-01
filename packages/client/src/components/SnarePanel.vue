<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls -->
    <div class="rack-column">
      <div class="module-group snare-panel">
        <h3>Snare Machine</h3>
        <div class="knob-row">
          <Knob label="Tune" :min="100" :max="250" :step="1" :defaultValue="DEFAULTS.tune" format="hz" :modelValue="params.tune" @update:modelValue="ks.set('tune', $event)" :syncPath="ks.pathFor('tune')" @gesture-end="ks.end('tune')" />
          <Knob label="Decay" :min="0.05" :max="0.8" :step="0.01" :defaultValue="DEFAULTS.decay" format="ms" :modelValue="params.decay" @update:modelValue="ks.set('decay', $event)" :syncPath="ks.pathFor('decay')" @gesture-end="ks.end('decay')" />
          <Knob label="Snappy" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.snappy" format="percent" :modelValue="params.snappy" @update:modelValue="ks.set('snappy', $event)" :syncPath="ks.pathFor('snappy')" @gesture-end="ks.end('snappy')" />
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
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SnareEngine.DEFAULT_PARAMS;
const ks = useKnobSync('snare');

defineProps<{
  params: EngineParamsMap['snare'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>


