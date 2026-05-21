<template>
  <div class="module-group hat-panel">
    <h3>Hat Machine</h3>
    <div class="knob-row">
      <Knob label="Decay" :min="0.02" :max="0.6" :step="0.01" v-model="decay" />
      <Knob label="Tone" :min="3000" :max="14000" :step="100" v-model="tone" />
      <Knob label="Metallic" :min="0" :max="1" :step="0.01" v-model="metallic" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

const decay = defineModel<number>('decay', { required: true });
const tone = defineModel<number>('tone', { required: true });
const metallic = defineModel<number>('metallic', { required: true });
</script>

<style scoped>
.module-group { 
  background: #222; 
  padding: 15px; 
  border-radius: 8px; 
  min-width: 320px;
}
h3 { 
  margin-top: 0; 
  color: #888; 
  border-bottom: 1px solid #333; 
  padding-bottom: 5px; 
  font-family: monospace;
  text-transform: uppercase;
  font-size: 0.9rem;
  letter-spacing: 0.05em;
}
.knob-row { 
  display: flex; 
  gap: 20px; 
  justify-content: space-around;
  padding: 10px 0;
}
</style>
