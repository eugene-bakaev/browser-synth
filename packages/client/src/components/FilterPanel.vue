<template>
  <div class="module-group">
    <h3>Filter</h3>
    <div class="knob-row">
      <Knob label="Cutoff" :min="20" :max="20000" :step="1" :defaultValue="DEFAULTS.filterCutoff" format="hz" v-model="params.filterCutoff" :syncPath="ks.pathFor('filterCutoff')" @gesture-end="ks.end('filterCutoff')" />
      <Knob label="Res" :min="0" :max="20" :step="0.1" :defaultValue="DEFAULTS.filterRes" format="ratio" v-model="params.filterRes" :syncPath="ks.pathFor('filterRes')" @gesture-end="ks.end('filterRes')" />
      <Knob label="Env Amt" :min="-4" :max="4" :step="0.1" :defaultValue="DEFAULTS.filterEnvAmount" format="octave" v-model="params.filterEnvAmount" :syncPath="ks.pathFor('filterEnvAmount')" @gesture-end="ks.end('filterEnvAmount')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

defineProps<{
  params: EngineParamsMap['synth'];
}>();
</script>


