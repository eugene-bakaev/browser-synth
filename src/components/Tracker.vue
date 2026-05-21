<template>
  <div class="tracker-container" :style="{ '--track-color': color || '#00f0ff' }" :class="{ focused: isFocused }">
    <div class="tracker-title-bar" @click="$emit('select-track')">
      <span class="track-name">{{ title }}</span>
      <span class="focus-hint" v-if="!isFocused">EDIT SYNTH</span>
    </div>

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
  title: string;
  color?: string;
  isFocused?: boolean;
}>();

defineEmits<{
  (e: 'select-track'): void;
}>();
</script>

<style scoped>
.tracker-container {
  display: flex;
  flex-direction: column;
  background: #111;
  padding: 10px;
  border-radius: 6px;
  font-family: monospace;
  width: 260px;
  border: 1px solid #222;
  transition: border-color 0.3s, box-shadow 0.3s;
}

.tracker-container.focused {
  border-color: var(--track-color);
  box-shadow: 0 0 10px rgba(var(--track-color), 0.15);
}

.tracker-title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #181818;
  border-bottom: 2px solid var(--track-color);
  padding: 6px 8px;
  margin-bottom: 8px;
  cursor: pointer;
  border-radius: 4px 4px 0 0;
  user-select: none;
  transition: background-color 0.2s;
}

.tracker-title-bar:hover {
  background: #222;
}

.track-name {
  font-weight: bold;
  color: var(--track-color);
  font-size: 0.85rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.focus-hint {
  font-size: 0.65rem;
  color: #666;
  font-weight: bold;
  border: 1px solid #333;
  padding: 1px 4px;
  border-radius: 3px;
  transition: color 0.2s, border-color 0.2s;
}

.tracker-title-bar:hover .focus-hint {
  color: var(--track-color);
  border-color: var(--track-color);
}

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
  font-size: 0.75rem;
}

.tracker-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.step-row {
  background: #1a1a1a;
  border: 1px solid #282828;
  padding: 2px;
  border-radius: 3px;
}

.step-row.active {
  background: #333;
  border-color: var(--track-color);
}

.col-step { text-align: center; color: #555; font-size: 0.75rem; }

select, input { 
  box-sizing: border-box;
  height: 24px;
  margin: 0;
  background: #000; 
  color: #0f0; 
  border: 1px solid #2a2a2a; 
  font-family: monospace; 
  font-size: 0.85rem;
  width: 100%;
  padding: 0;
  text-align: center;
  text-align-last: center;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 3px;
  display: block;
}

select:focus, input:focus {
  border-color: var(--track-color);
  outline: none;
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