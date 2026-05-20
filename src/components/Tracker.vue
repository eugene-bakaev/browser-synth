<template>
  <div class="tracker-container">
    <!-- Header Row -->
    <div class="tracker-header">
      <div class="col-step">STEP</div>
      <div class="col-note">NOTE</div>
      <div class="col-oct">OCT</div>
      <div class="col-len">LEN</div>
    </div>
    
    <!-- Vertical Steps -->
    <div class="tracker-steps">
      <div 
        v-for="(step, i) in steps" 
        :key="i" 
        class="step-row" 
        :class="{ active: currentStep === i }"
      >
        <div class="col-step step-num">{{ i.toString().padStart(2, '0') }}</div>
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
  width: max-content;
}

.tracker-header {
  display: flex;
  color: #888;
  font-weight: bold;
  padding-bottom: 5px;
  border-bottom: 1px solid #333;
  margin-bottom: 5px;
}

.tracker-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 400px;
  overflow-y: auto;
}

.step-row {
  display: flex;
  align-items: center;
  background: #222;
  border: 1px solid #333;
  padding: 2px 0;
}

.step-row.active {
  background: #444;
  border-color: #666;
}

/* Explicit Column Widths */
.col-step { width: 40px; text-align: center; color: #666; font-size: 0.8rem; }
.col-note { width: 60px; text-align: center; }
.col-oct { width: 40px; text-align: center; }
.col-len { width: 50px; text-align: center; }

select, input { 
  background: #000; 
  color: #0f0; 
  border: none; 
  font-family: monospace; 
  width: 100%; 
  height: 20px; 
  text-align: center; 
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
