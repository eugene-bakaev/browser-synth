<template>
  <div class="module-group">
    <h3>Filter</h3>
    <div class="knob-row">
      <Knob label="Cutoff" :min="20" :max="20000" :step="1" :defaultValue="DEFAULTS.filterCutoff" format="hz" v-model="cutoff" />
      <Knob label="Res" :min="0" :max="20" :step="0.1" :defaultValue="DEFAULTS.filterRes" format="ratio" v-model="res" />
      <Knob label="Env Amt" :min="-4" :max="4" :step="0.1" :defaultValue="DEFAULTS.filterEnvAmount" format="octave" v-model="envAmount" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;

const cutoff = defineModel<number>('cutoff', { required: true });
const res = defineModel<number>('res', { required: true });
const envAmount = defineModel<number>('envAmount', { required: true });
</script>


