<template>
  <div class="module-group">
    <h3>Filter</h3>
    <div class="knob-row">
      <Knob label="Cutoff" :min="20" :max="10000" :step="1" v-model="cutoff" />
      <Knob label="Res" :min="0" :max="20" :step="0.1" v-model="res" />
      <Knob label="Env Amt" :min="0" :max="5000" :step="10" v-model="envAmount" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

const cutoff = defineModel<number>('cutoff', { required: true });
const res = defineModel<number>('res', { required: true });
const envAmount = defineModel<number>('envAmount', { required: true });
</script>


