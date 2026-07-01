<template>
  <div class="module-group">
    <h3>Filter</h3>
    <div class="knob-row">
      <Knob label="Cutoff" :min="20" :max="20000" :step="1" :defaultValue="DEFAULTS.filterCutoff" format="hz" :modelValue="params.filterCutoff" @update:modelValue="ks.set('filterCutoff', $event)" :syncPath="ks.pathFor('filterCutoff')" @gesture-end="ks.end('filterCutoff')" />
      <Knob label="Res" :min="0" :max="20" :step="0.1" :defaultValue="DEFAULTS.filterRes" format="ratio" :modelValue="params.filterRes" @update:modelValue="ks.set('filterRes', $event)" :syncPath="ks.pathFor('filterRes')" @gesture-end="ks.end('filterRes')" />
      <Knob label="Env Amt" :min="-4" :max="4" :step="0.1" :defaultValue="DEFAULTS.filterEnvAmount" format="octave" :modelValue="params.filterEnvAmount" @update:modelValue="ks.set('filterEnvAmount', $event)" :syncPath="ks.pathFor('filterEnvAmount')" @gesture-end="ks.end('filterEnvAmount')" />
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


