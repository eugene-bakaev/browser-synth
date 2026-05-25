<template>
  <div class="module-group">
    <h3>Oscillators</h3>

    <div class="osc-mode-row">
      <label>OSC MODE</label>
      <select v-model="oscMode">
        <option value="free-run">free-run</option>
        <option value="phase-offset">phase-offset</option>
        <option value="retrigger-recreate">retrigger-recreate</option>
        <option value="retrigger-wavetable">retrigger-wavetable</option>
      </select>
    </div>

    <div class="osc-row">
      <div class="osc-unit">
        <h4>OSC 1</h4>
        <select v-model="osc1Type">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" :defaultValue="DEFAULTS.osc1Coarse" format="octave" v-model="osc1Coarse" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" :defaultValue="DEFAULTS.osc1Fine" format="cents" v-model="osc1Fine" />
          <div :class="{ inert: oscMode === 'free-run' }">
            <Knob label="Phase" :min="0" :max="360" :step="1" :defaultValue="DEFAULTS.osc1Phase" format="degrees" v-model="osc1Phase" />
          </div>
        </div>
      </div>
      <div class="osc-unit">
        <h4>OSC 2</h4>
        <select v-model="osc2Type">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" :defaultValue="DEFAULTS.osc2Coarse" format="octave" v-model="osc2Coarse" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" :defaultValue="DEFAULTS.osc2Fine" format="cents" v-model="osc2Fine" />
          <div :class="{ inert: oscMode === 'free-run' }">
            <Knob label="Phase" :min="0" :max="360" :step="1" :defaultValue="DEFAULTS.osc2Phase" format="degrees" v-model="osc2Phase" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import type { OscMode } from '../engine/modules/oscillator';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;

defineProps<{
  waveforms: OscillatorType[];
}>();

const oscMode = defineModel<OscMode>('oscMode', { required: true });
const osc1Type = defineModel<OscillatorType>('osc1Type', { required: true });
const osc1Coarse = defineModel<number>('osc1Coarse', { required: true });
const osc1Fine = defineModel<number>('osc1Fine', { required: true });
const osc1Phase = defineModel<number>('osc1Phase', { required: true });

const osc2Type = defineModel<OscillatorType>('osc2Type', { required: true });
const osc2Coarse = defineModel<number>('osc2Coarse', { required: true });
const osc2Fine = defineModel<number>('osc2Fine', { required: true });
const osc2Phase = defineModel<number>('osc2Phase', { required: true });
</script>

<style scoped>
.osc-mode-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.osc-mode-row label { font-size: 0.7rem; color: #888; font-weight: bold; letter-spacing: 0.05em; }
.osc-mode-row select { background: #000; color: #fff; border: 1px solid #444; padding: 4px 6px; border-radius: 3px; flex: 1; font-size: 0.75rem; }

.osc-row { display: flex; flex-direction: column; gap: 12px; }
.osc-unit { background: #333; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; }
.osc-unit h4 { margin: 0 0 10px 0; font-size: 0.8rem; color: #888; }
.osc-knobs { display: flex; gap: 15px; }
select { background: #000; color: #fff; border: 1px solid #444; padding: 5px; margin-bottom: 10px; border-radius: 3px; }

/* Phase knobs only matter in modes other than free-run. Render dim to signal
   they currently have no audible effect, but keep them interactive so a
   pre-set value sticks when the user flips to phase-offset / retrigger. */
.inert { opacity: 0.4; }
</style>
