<template>
  <div class="module-group kick-panel">
    <h3>Kick Machine</h3>
    <div class="knob-row">
      <Knob label="Tune" :min="40" :max="120" :step="1" v-model="tune" />
      <Knob label="Decay" :min="0.05" :max="1.5" :step="0.01" v-model="decay" />
      <Knob label="Click" :min="0" :max="1" :step="0.01" v-model="click" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

const tune = defineModel<number>('tune', { required: true });
const decay = defineModel<number>('decay', { required: true });
const click = defineModel<number>('click', { required: true });
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
