# Fiddle Synth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modular sound playground with 2 oscillators, mixer, filter, 2 envelopes, and a 16-step tracker-style sequencer using Vue 3 and Vite.

**Architecture:** A decoupled system where a `SynthEngine` manages a graph of `AudioNode` wrappers. A `Sequencer` handles timing and triggers the engine via a clean `noteOn/noteOff` interface. Vue 3 provides the reactive "knob" UI.

**Tech Stack:** Vue 3, Vite, TypeScript, Web Audio API.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.ts`, `src/App.vue`

- [ ] **Step 1: Create `package.json`**
```json
{
  "name": "browser-synth",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.4.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "typescript": "^5.2.0",
    "vite": "^5.0.0",
    "vue-tsc": "^1.8.0"
  }
}
```

- [ ] **Step 2: Create `vite.config.ts`**
```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
})
```

- [ ] **Step 3: Create `index.html`**
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fiddle Synth</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Create basic `src/App.vue`**
```vue
<template>
  <div class="synth-container">
    <h1>Fiddle Synth</h1>
    <button @click="startAudio">Start Audio</button>
  </div>
</template>

<script setup lang="ts">
const startAudio = () => {
  console.log('Audio Context Start requested');
}
</script>

<style>
body { margin: 0; background: #1a1a1a; color: #eee; font-family: sans-serif; }
.synth-container { padding: 2rem; }
</style>
```

- [ ] **Step 5: Initialize `src/main.ts`**
```typescript
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

- [ ] **Step 6: Install dependencies**
Run: `npm install`

- [ ] **Step 7: Commit**
```bash
git add .
git commit -m "chore: scaffold vite-vue project"
```

---

### Task 2: Core Engine & Module Interfaces

**Files:**
- Create: `src/engine/types.ts`, `src/engine/Module.ts`, `src/engine/PatchBay.ts`

- [ ] **Step 1: Define core types in `src/engine/types.ts`**
```typescript
export type ModulePort = AudioNode | AudioParam;

export interface Module {
  readonly name: string;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;
}
```

- [ ] **Step 2: Implement `PatchBay` in `src/engine/PatchBay.ts`**
```typescript
import { ModulePort } from './types';

export class PatchBay {
  connect(source: ModulePort, target: ModulePort) {
    if (source instanceof AudioNode) {
      if (target instanceof AudioNode) {
        source.connect(target);
      } else if (target instanceof AudioParam) {
        source.connect(target);
      }
    }
  }

  disconnect(source: ModulePort, target: ModulePort) {
    if (source instanceof AudioNode) {
        source.disconnect(target as any);
    }
  }
}
```

- [ ] **Step 3: Commit**
```bash
git add src/engine/
git commit -m "feat: add engine types and patchbay"
```

---

### Task 3: Oscillator & Mixer Modules

**Files:**
- Create: `src/engine/modules/Oscillator.ts`, `src/engine/modules/Mixer.ts`

- [ ] **Step 1: Create `Oscillator` module**
```typescript
import { Module, ModulePort } from '../types';

export class OscillatorModule implements Module {
  readonly name = 'Oscillator';
  private osc: OscillatorNode;
  private gain: GainNode;
  
  readonly inputs = {};
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.osc = ctx.createOscillator();
    this.gain = ctx.createGain();
    this.osc.connect(this.gain);
    this.osc.start();
    this.outputs = { main: this.gain };
  }

  setFrequency(freq: number) {
    this.osc.frequency.setValueAtTime(freq, 0);
  }

  setWaveform(type: OscillatorType) {
    this.osc.type = type;
  }
}
```

- [ ] **Step 2: Create `Mixer` module**
```typescript
import { Module, ModulePort } from '../types';

export class MixerModule implements Module {
  readonly name = 'Mixer';
  private gain: GainNode;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.gain = ctx.createGain();
    this.inputs = { main: this.gain };
    this.outputs = { main: this.gain };
  }
}
```

- [ ] **Step 3: Commit**
```bash
git add src/engine/modules/
git commit -m "feat: add oscillator and mixer modules"
```

---

### Task 4: Filter & Envelope Modules

**Files:**
- Create: `src/engine/modules/Filter.ts`, `src/engine/modules/Envelope.ts`

- [ ] **Step 1: Create `Filter` module**
```typescript
import { Module, ModulePort } from '../types';

export class FilterModule implements Module {
  readonly name = 'Filter';
  private filter: BiquadFilterNode;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.inputs = { 
        main: this.filter,
        cutoff: this.filter.frequency 
    };
    this.outputs = { main: this.filter };
  }
}
```

- [ ] **Step 2: Create `Envelope` module (ADSR logic)**
```typescript
import { Module, ModulePort } from '../types';

export class EnvelopeModule {
  a = 0.01; d = 0.2; s = 0.5; r = 0.5;

  trigger(param: AudioParam, time: number, duration: number) {
    param.cancelScheduledValues(time);
    param.setValueAtTime(0, time);
    param.linearRampToValueAtTime(1, time + this.a);
    param.linearRampToValueAtTime(this.s, time + this.a + this.d);
    
    const releaseTime = time + duration;
    param.cancelScheduledValues(releaseTime);
    param.setValueAtTime(this.s, releaseTime);
    param.linearRampToValueAtTime(0, releaseTime + this.r);
  }
}
```

- [ ] **Step 3: Commit**
```bash
git add src/engine/modules/
git commit -m "feat: add filter and envelope modules"
```

---

### Task 5: Synth Engine Orchestration

**Files:**
- Create: `src/engine/SynthEngine.ts`

- [ ] **Step 1: Implement `SynthEngine` to wire modules together**
```typescript
import { PatchBay } from './PatchBay';
import { OscillatorModule } from './modules/Oscillator';
import { MixerModule } from './modules/Mixer';
import { FilterModule } from './modules/Filter';
import { EnvelopeModule } from './modules/Envelope';

export class SynthEngine {
  private ctx: AudioContext;
  private patchBay: PatchBay;
  
  osc1: OscillatorModule;
  osc2: OscillatorModule;
  mixer: MixerModule;
  filter: FilterModule;
  ampEnv: EnvelopeModule;
  filterEnv: EnvelopeModule;
  masterVCA: GainNode;

  constructor() {
    this.ctx = new AudioContext();
    this.patchBay = new PatchBay();
    
    this.osc1 = new OscillatorModule(this.ctx);
    this.osc2 = new OscillatorModule(this.ctx);
    this.mixer = new MixerModule(this.ctx);
    this.filter = new FilterModule(this.ctx);
    this.ampEnv = new EnvelopeModule();
    this.filterEnv = new EnvelopeModule();
    this.masterVCA = this.ctx.createGain();
    this.masterVCA.gain.value = 0;

    // Hardwired routing for now
    this.patchBay.connect(this.osc1.outputs.main, this.mixer.inputs.main);
    this.patchBay.connect(this.osc2.outputs.main, this.mixer.inputs.main);
    this.patchBay.connect(this.mixer.outputs.main, this.filter.inputs.main);
    this.patchBay.connect(this.filter.outputs.main, this.masterVCA);
    this.masterVCA.connect(this.ctx.destination);
  }

  trigger(freq: number, duration: number) {
    const now = this.ctx.currentTime;
    this.osc1.setFrequency(freq);
    this.osc2.setFrequency(freq * 1.01); // slight detune
    
    this.ampEnv.trigger(this.masterVCA.gain, now, duration);
    // Envelope 2 modulations...
  }
}
```

- [ ] **Step 2: Commit**
```bash
git add src/engine/SynthEngine.ts
git commit -m "feat: implement SynthEngine orchestration"
```

---

### Task 6: Sequencer Implementation

**Files:**
- Create: `src/sequencer/Sequencer.ts`

- [ ] **Step 1: Implement the 16-step tracker logic**
```typescript
export interface Step {
  note: string | null;
  octave: number;
}

export class Sequencer {
  steps: Step[] = Array(16).fill(null).map(() => ({ note: null, octave: 4 }));
  bpm = 120;
  private currentStep = 0;
  private timer: number | null = null;

  start(callback: (step: Step) => void) {
    const stepTime = (60 / this.bpm) / 4; // 16th notes
    this.timer = window.setInterval(() => {
      callback(this.steps[this.currentStep]);
      this.currentStep = (this.currentStep + 1) % 16;
    }, stepTime * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
```

- [ ] **Step 2: Commit**
```bash
git add src/sequencer/
git commit -m "feat: add 16-step sequencer"
```

---

### Task 7: Reactive UI (Knobs & Tracker)

**Files:**
- Create: `src/components/Knob.vue`, `src/components/Tracker.vue`
- Modify: `src/App.vue`

- [ ] **Step 1: Create a simple `Knob` component**
```vue
<template>
  <div class="knob">
    <label>{{ label }}</label>
    <input type="range" :min="min" :max="max" :step="step" v-model="value" @input="$emit('update:modelValue', Number(value))">
    <span>{{ value }}</span>
  </div>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps(['label', 'min', 'max', 'step', 'modelValue']);
const value = ref(props.modelValue);
</script>
```

- [ ] **Step 2: Create the `Tracker` grid component**
- [ ] **Step 3: Wire everything in `App.vue` with Vue reactivity**
- [ ] **Step 4: Commit**
```bash
git add src/components/ src/App.vue
git commit -m "feat: implement reactive UI"
```
