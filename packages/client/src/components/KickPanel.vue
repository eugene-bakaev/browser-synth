<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls -->
    <div class="rack-column">
      <div class="module-group kick-panel">
        <h3>Kick Machine</h3>
        <div class="knob-row">
          <Knob label="Tune" :min="40" :max="120" :step="1" :defaultValue="DEFAULTS.tune" format="hz" :modelValue="params.tune" @update:modelValue="ks.set('tune', $event)" :syncPath="ks.pathFor('tune')" @gesture-end="ks.end('tune')" />
          <Knob label="Decay" :min="0.05" :max="1.5" :step="0.01" :defaultValue="DEFAULTS.decay" format="ms" :modelValue="params.decay" @update:modelValue="ks.set('decay', $event)" :syncPath="ks.pathFor('decay')" @gesture-end="ks.end('decay')" />
          <Knob label="Click" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.click" format="percent" :modelValue="params.click" @update:modelValue="ks.set('click', $event)" :syncPath="ks.pathFor('click')" @gesture-end="ks.end('click')" />
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
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = KickEngine.DEFAULT_PARAMS;
const ks = useKnobSync('kick');

defineProps<{
  params: EngineParamsMap['kick'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>


