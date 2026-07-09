<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls — knobs generated from the descriptor table -->
    <div class="rack-column">
      <div class="module-group hat-panel">
        <h3>Clap 2 · Worklet</h3>
        <div class="knob-row">
          <Knob
            v-for="d in CLAP2_DESCRIPTORS"
            :key="d.key"
            :label="d.label"
            :min="d.min"
            :max="d.max"
            :step="d.step ?? (d.max - d.min) / 100"
            :defaultValue="d.default"
            :format="d.format"
            :curve="d.curve"
            :modelValue="params[d.key as keyof typeof params]" @update:modelValue="ks.set(d.key, $event)"
            :syncPath="ks.pathFor(d.key)"
            @gesture-end="ks.end(d.key)"
          />
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
import { CLAP2_DESCRIPTORS } from '@fiddle/shared';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const ks = useKnobSync('clap2');

defineProps<{
  params: EngineParamsMap['clap2'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>
