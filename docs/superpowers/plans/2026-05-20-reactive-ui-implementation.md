# Reactive UI (Knobs & Tracker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the UI components (Knob and Tracker) and wire them to the SynthEngine and Sequencer in `App.vue`.

**Architecture:** 
- `utils/notes.ts`: Logic for converting note names and octaves to frequencies.
- `Knob.vue`: A reusable component for range inputs with labeling.
- `Tracker.vue`: A step sequencer interface for editing note patterns.
- `App.vue`: The central hub that orchestrates the engine, sequencer, and UI components using Vue's reactivity system.

**Tech Stack:** Vue 3 (Composition API), TypeScript, Web Audio API.

---

### Task 1: Create Note Utils

**Files:**
- Create: `src/utils/notes.ts`

- [ ] **Step 1: Implement noteToFreq and NOTES constant**

```typescript
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteToFreq(note: string, octave: number): number {
  const index = NOTES.indexOf(note);
  if (index === -1) return 0;
  // A4 = 440Hz, which is index 9 at octave 4
  const n = index + (octave * 12) - (4 * 12 + 9);
  return 440 * Math.pow(2, n / 12);
}

export { NOTES };
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/notes.ts
git commit -m "feat: add note to frequency utility"
```

### Task 2: Implement Knob Component

**Files:**
- Create: `src/components/Knob.vue`

- [ ] **Step 1: Implement Knob.vue**

```vue
<template>
  <div class="knob">
    <label>{{ label }}</label>
    <div class="control">
      <input 
        type="range" 
        :min="min" 
        :max="max" 
        :step="step" 
        :value="modelValue" 
        @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
      >
      <span>{{ modelValue }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string;
  min: number;
  max: number;
  step: number;
  modelValue: number;
}>();

defineEmits(['update:modelValue']);
</script>

<style scoped>
.knob { display: flex; flex-direction: column; align-items: center; margin: 5px; }
.control { display: flex; align-items: center; gap: 5px; }
label { font-size: 0.8rem; color: #aaa; }
span { font-family: monospace; min-width: 40px; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Knob.vue
git commit -m "feat: add Knob component"
```

### Task 3: Implement Tracker Component

**Files:**
- Create: `src/components/Tracker.vue`

- [ ] **Step 1: Implement Tracker.vue**

```vue
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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Tracker.vue
git commit -m "feat: add Tracker component"
```

### Task 4: Orchestrate in App.vue

**Files:**
- Modify: `src/App.vue`

- [ ] **Step 1: Update App.vue with engine/sequencer integration and UI**

```vue
<template>
  <div class="synth-container">
    <header>
      <h1>Fiddle Synth</h1>
      <div class="transport">
        <button @click="togglePlay" :class="{ playing: sequencer.isPlaying }">
          {{ sequencer.isPlaying ? 'STOP' : 'PLAY' }}
        </button>
        <div class="bpm">
          <label>BPM</label>
          <input type="number" v-model.number="sequencer.bpm" min="40" max="240">
        </div>
      </div>
    </header>

    <section class="sequencer-section">
      <Tracker :steps="sequencer.steps" :currentStep="currentStep" />
    </section>

    <section class="engine-section">
      <div class="module-group">
        <h3>Filter</h3>
        <Knob label="Cutoff" :min="20" :max="10000" :step="1" v-model="filterCutoff" />
        <Knob label="Res" :min="0" :max="20" :step="0.1" v-model="filterRes" />
      </div>

      <div class="module-group">
        <h3>Amp Env</h3>
        <Knob label="A" :min="0" :max="2" :step="0.01" v-model="engine.ampEnv.a" />
        <Knob label="D" :min="0" :max="2" :step="0.01" v-model="engine.ampEnv.d" />
        <Knob label="S" :min="0" :max="1" :step="0.01" v-model="engine.ampEnv.s" />
        <Knob label="R" :min="0" :max="5" :step="0.01" v-model="engine.ampEnv.r" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { SynthEngine } from './engine/SynthEngine';
import { Sequencer } from './sequencer/Sequencer';
import { noteToFreq } from './utils/notes';
import Tracker from './components/Tracker.vue';
import Knob from './components/Knob.vue';

const engine = new SynthEngine();
const sequencer = reactive(new Sequencer());
const currentStep = ref(-1);

// Bridge reactive state to engine params
const filterCutoff = ref(2000);
const filterRes = ref(1);

watch(filterCutoff, (val) => {
  if (engine.filter.inputs.cutoff instanceof AudioParam) {
    engine.filter.inputs.cutoff.setTargetAtTime(val, engine.ctx.currentTime, 0.05);
  }
});

watch(filterRes, (val) => {
  if (engine.filter.inputs.resonance instanceof AudioParam) {
    engine.filter.inputs.resonance.setTargetAtTime(val, engine.ctx.currentTime, 0.05);
  }
});

const togglePlay = () => {
  if (sequencer.isPlaying) {
    sequencer.stop();
    currentStep.value = -1;
  } else {
    sequencer.start((step) => {
      // currentStep is managed by sequencer internally, but we need to track it for UI
      // Sequencer.ts increments currentStep internally. We need to sync.
      // Actually, Sequencer.ts should probably emit the current step index in callback.
      // But for now, we'll follow the provided implementation.
    });
  }
};

// Re-implementing togglePlay to match the requirement's callback logic
// Note: The requirement's App.vue snippet had specific logic for currentStep.value
</script>

<style>
body { margin: 0; background: #1a1a1a; color: #eee; font-family: sans-serif; }
.synth-container { max-width: 800px; margin: 0 auto; padding: 20px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.transport { display: flex; gap: 20px; align-items: center; }
button { padding: 10px 20px; background: #444; color: #fff; border: none; cursor: pointer; }
button.playing { background: #0f0; color: #000; }
.module-group { background: #222; padding: 15px; border-radius: 8px; margin-top: 20px; }
h3 { margin-top: 0; color: #888; border-bottom: 1px solid #333; }
</style>
```

- [ ] **Step 2: Correct togglePlay implementation to match specific requirement logic**

```typescript
const togglePlay = () => {
  if (sequencer.isPlaying) {
    sequencer.stop();
    currentStep.value = -1;
  } else {
    sequencer.start((step) => {
      currentStep.value = (currentStep.value + 1) % 16;
      if (step.note) {
        const freq = noteToFreq(step.note, step.octave);
        engine.trigger(freq, 0.1);
      }
    });
  }
};
```

- [ ] **Step 3: Commit**

```bash
git add src/App.vue
git commit -m "feat: orchestrate engine, sequencer and UI in App.vue"
```
