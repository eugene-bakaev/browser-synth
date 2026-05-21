<template>
  <div class="env-row">
    <div class="module-group">
      <h3>Filter Env</h3>
      <div class="knob-row">
        <Knob label="A" :min="0" :max="2" :step="0.01" v-model="filterEnv.a" />
        <Knob label="D" :min="0" :max="2" :step="0.01" v-model="filterEnv.d" />
        <Knob label="S" :min="0" :max="1" :step="0.01" v-model="filterEnv.s" />
        <Knob label="R" :min="0" :max="5" :step="0.01" v-model="filterEnv.r" />
      </div>
    </div>

    <div class="module-group">
      <h3>Amp Env</h3>
      <div class="knob-row">
        <Knob label="A" :min="0" :max="2" :step="0.01" v-model="ampEnv.a" />
        <Knob label="D" :min="0" :max="2" :step="0.01" v-model="ampEnv.d" />
        <Knob label="S" :min="0" :max="1" :step="0.01" v-model="ampEnv.s" />
        <Knob label="R" :min="0" :max="5" :step="0.01" v-model="ampEnv.r" />
      </div>
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
.env-row { display: flex; gap: 20px; }
.module-group { flex: 1; margin-top: 0; background: #222; padding: 15px; border-radius: 8px; }
h3 { margin-top: 0; color: #888; border-bottom: 1px solid #333; padding-bottom: 5px; }
.knob-row { display: flex; gap: 15px; flex-wrap: wrap; }
</style>
