<template>
  <div class="module-group kick-panel">
    <h3>Kick Machine</h3>
    <div class="knob-row">
      <Knob label="Tune" :min="40" :max="120" :step="1" format="hz" v-model="tune" />
      <Knob label="Decay" :min="0.05" :max="1.5" :step="0.01" format="ms" v-model="decay" />
      <Knob label="Click" :min="0" :max="1" :step="0.01" format="percent" v-model="click" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

const tune = defineModel<number>('tune', { required: true });
const decay = defineModel<number>('decay', { required: true });
const click = defineModel<number>('click', { required: true });
</script>


