<template>
  <div class="tracker">
    <div 
      v-for="(step, i) in steps" 
      :key="i" 
      class="step" 
      :class="{ active: currentStep === i }"
    >
      <div class="step-num">{{ i.toString().padStart(2, '0') }}</div>
      <select v-model="step.note">
        <option :value="null">---</option>
        <option v-for="n in NOTES" :key="n" :value="n">{{ n }}</option>
      </select>
      <input type="number" v-model.number="step.octave" min="0" max="8">
    </div>
  </div>
</template>

<script setup lang="ts">
import { NOTES } from '../utils/notes';
import type { Step } from '../sequencer/Sequencer';

defineProps<{
  steps: Step[];
  currentStep: number;
}>();
</script>

<style scoped>
.tracker { display: flex; flex-wrap: wrap; gap: 5px; background: #222; padding: 10px; border-radius: 4px; }
.step { display: flex; flex-direction: column; align-items: center; padding: 5px; border: 1px solid #333; }
.step.active { background: #444; border-color: #666; }
.step-num { font-size: 0.7rem; color: #666; }
select, input { background: #000; color: #0f0; border: none; font-family: monospace; width: 40px; }
</style>
