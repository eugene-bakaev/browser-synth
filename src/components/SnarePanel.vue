<template>
  <div class="module-group snare-panel">
    <h3>Snare Machine</h3>
    <div class="knob-row">
      <Knob label="Tune" :min="100" :max="250" :step="1" format="hz" v-model="tune" />
      <Knob label="Decay" :min="0.05" :max="0.8" :step="0.01" format="ms" v-model="decay" />
      <Knob label="Snappy" :min="0" :max="1" :step="0.01" format="percent" v-model="snappy" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

const tune = defineModel<number>('tune', { required: true });
const decay = defineModel<number>('decay', { required: true });
const snappy = defineModel<number>('snappy', { required: true });
</script>


