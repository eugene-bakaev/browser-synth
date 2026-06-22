<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls — knobs generated from the descriptor table -->
    <div class="rack-column">
      <div class="module-group snare-panel">
        <h3>Snare 2 · Worklet</h3>
        <div class="knob-row">
          <Knob
            v-for="d in SNARE2_DESCRIPTORS"
            :key="d.key"
            :label="d.label"
            :min="d.min"
            :max="d.max"
            :step="(d.max - d.min) / 100"
            :defaultValue="d.default"
            :format="d.format"
            :curve="d.curve"
            v-model="params[d.key as keyof typeof params]"
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
import { SNARE2_DESCRIPTORS } from '@fiddle/shared';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const ks = useKnobSync('snare2');

defineProps<{
  params: EngineParamsMap['snare2'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>

<style scoped>
/* snare2 has 7 knobs — more than the 3-knob analog drum panels (like kick2's 8) —
   so wrap them into rows instead of overflowing the rack column (the default
   .knob-row is flex-nowrap). Scoped, so only this panel is affected. */
.knob-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 10px;
  justify-content: flex-start;
}
</style>
