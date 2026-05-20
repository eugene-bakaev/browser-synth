<template>
  <div class="tracker-container">
    <div class="tracker-row tracker-header">
      <div class="col-step">STEP</div>
      <div class="col-note">NOTE</div>
      <div class="col-oct">OCT</div>
      <div class="col-len">LEN</div>
    </div>
    
    <div class="tracker-steps">
      <div 
        v-for="(step, i) in steps" 
        :key="i" 
        class="tracker-row step-row" 
        :class="{ active: currentStep === i }"
      >
        <div class="col-step">{{ i.toString().padStart(2, '0') }}</div>
        <div class="col-note">
          <select v-model="step.note">
            <option :value="null">---</option>
            <option v-for="n in NOTES" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>
        <div class="col-oct">
          <input type="number" v-model.number="step.octave" min="0" max="8" title="Octave">
        </div>
        <div class="col-len">
          <input type="number" v-model.number="step.length" min="1" max="16" title="Length (ticks)">
        </div>
      </div>
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
.tracker-container {
  display: flex;
  flex-direction: column;
  background: #111;
  padding: 10px;
  border-radius: 4px;
  font-family: monospace;
  width: 260px; /* Fixed width to contain the grid nicely */
}

/* CSS Grid guarantees perfectly aligned columns */
.tracker-row {
  display: grid;
  grid-template-columns: 40px 70px 45px 55px;
  align-items: center;
  gap: 5px;
}

.tracker-header {
  color: #888;
  font-weight: bold;
  padding-bottom: 5px;
  border-bottom: 1px solid #333;
  margin-bottom: 5px;
  text-align: center;
}

.tracker-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.step-row {
  background: #222;
  border: 1px solid #333;
  padding: 2px;
}

.step-row.active {
  background: #444;
  border-color: #666;
}

.col-step { text-align: center; color: #666; font-size: 0.8rem; }

select, input { 
  background: #000; 
  color: #0f0; 
  border: 1px solid #000; 
  font-family: monospace; 
  font-size: 0.9rem;
  width: 100%;
  padding: 2px 0;
  text-align: center;
  text-align-last: center; /* Fixes select text alignment */
  appearance: none;
  -webkit-appearance: none;
}

/* Hide number arrows for cleaner look */
input::-webkit-outer-spin-button, 
input::-webkit-inner-spin-button { 
  -webkit-appearance: none; 
  margin: 0; 
}
input[type=number] { 
  -moz-appearance: textfield; 
}
</style>