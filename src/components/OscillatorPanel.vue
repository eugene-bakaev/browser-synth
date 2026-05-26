<template>
  <div class="module-group">
    <h3>Oscillators</h3>
    <div class="osc-row">
      <div class="osc-unit">
        <h4>OSC 1</h4>
        <select v-model="osc1Type">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" :defaultValue="DEFAULTS.osc1Coarse" format="octave" v-model="osc1Coarse" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" :defaultValue="DEFAULTS.osc1Fine" format="cents" v-model="osc1Fine" />
          <Knob v-if="osc1Type === 'square'" label="Pulse" :min="0.05" :max="0.95" :step="0.01" :defaultValue="DEFAULTS.osc1PulseWidth" format="percent" v-model="osc1PulseWidth" />
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
          <Knob v-if="osc2Type === 'square'" label="Pulse" :min="0.05" :max="0.95" :step="0.01" :defaultValue="DEFAULTS.osc2PulseWidth" format="percent" v-model="osc2PulseWidth" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;

defineProps<{
  waveforms: OscillatorType[];
}>();

const osc1Type = defineModel<OscillatorType>('osc1Type', { required: true });
const osc1Coarse = defineModel<number>('osc1Coarse', { required: true });
const osc1Fine = defineModel<number>('osc1Fine', { required: true });
const osc1PulseWidth = defineModel<number>('osc1PulseWidth', { required: true });

const osc2Type = defineModel<OscillatorType>('osc2Type', { required: true });
const osc2Coarse = defineModel<number>('osc2Coarse', { required: true });
const osc2Fine = defineModel<number>('osc2Fine', { required: true });
const osc2PulseWidth = defineModel<number>('osc2PulseWidth', { required: true });
</script>

<style scoped>
.osc-row { display: flex; flex-direction: column; gap: 12px; }
.osc-unit { background: #333; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; }
.osc-unit h4 { margin: 0 0 10px 0; font-size: 0.8rem; color: #888; }
.osc-knobs { display: flex; gap: 15px; }
select { background: #000; color: #fff; border: 1px solid #444; padding: 5px; margin-bottom: 10px; border-radius: 3px; }
</style>
