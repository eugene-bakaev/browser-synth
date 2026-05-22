<template>
  <div class="module-group clap-panel">
    <h3>Clap Machine</h3>
    <div class="knob-row">
      <Knob label="Decay" :min="0.05" :max="0.8" :step="0.01" format="ms" v-model="decay" />
      <Knob label="Tone" :min="500" :max="3000" :step="10" format="hz" v-model="tone" />
      <Knob label="Sloppy" :min="0.005" :max="0.03" :step="0.001" format="ms" v-model="sloppy" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

const decay = defineModel<number>('decay', { required: true });
const tone = defineModel<number>('tone', { required: true });
const sloppy = defineModel<number>('sloppy', { required: true });
</script>


