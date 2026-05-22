<template>
  <div class="module-group">
    <h3>Filter Env</h3>
    <div class="knob-row">
      <Knob label="A" :min="0" :max="2" :step="0.01" format="ms" v-model="filterEnv.a" />
      <Knob label="D" :min="0" :max="2" :step="0.01" format="ms" v-model="filterEnv.d" />
      <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" v-model="filterEnv.s" />
      <Knob label="R" :min="0" :max="5" :step="0.01" format="ms" v-model="filterEnv.r" />
    </div>
  </div>

  <div class="module-group">
    <h3>Amp Env</h3>
    <div class="knob-row">
      <Knob label="A" :min="0" :max="2" :step="0.01" format="ms" v-model="ampEnv.a" />
      <Knob label="D" :min="0" :max="2" :step="0.01" format="ms" v-model="ampEnv.d" />
      <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" v-model="ampEnv.s" />
      <Knob label="R" :min="0" :max="5" :step="0.01" format="ms" v-model="ampEnv.r" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

defineProps<{
  filterEnv: { a: number; d: number; s: number; r: number };
  ampEnv: { a: number; d: number; s: number; r: number };
}>();
</script>

<style scoped>
.knob-row { display: flex; gap: 10px; flex-wrap: nowrap; }
</style>
