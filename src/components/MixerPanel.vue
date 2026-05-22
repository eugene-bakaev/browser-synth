<template>
  <div class="module-group">
    <h3>Mixer</h3>
    <div class="knob-row">
      <Knob label="OSC 1 Level" :min="0" :max="1" :step="0.01" v-model="osc1Level" />
      <Knob label="OSC 2 Level" :min="0" :max="1" :step="0.01" v-model="osc2Level" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

const osc1Level = defineModel<number>('osc1Level', { required: true });
const osc2Level = defineModel<number>('osc2Level', { required: true });
</script>


