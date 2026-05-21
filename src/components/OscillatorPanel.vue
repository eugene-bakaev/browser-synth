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
          <Knob label="Coarse" :min="-3" :max="3" :step="1" v-model="osc1Coarse" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" v-model="osc1Fine" />
        </div>
      </div>
      <div class="osc-unit">
        <h4>OSC 2</h4>
        <select v-model="osc2Type">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" v-model="osc2Coarse" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" v-model="osc2Fine" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';

defineProps<{
  waveforms: OscillatorType[];
}>();

const osc1Type = defineModel<OscillatorType>('osc1Type', { required: true });
const osc1Coarse = defineModel<number>('osc1Coarse', { required: true });
const osc1Fine = defineModel<number>('osc1Fine', { required: true });

const osc2Type = defineModel<OscillatorType>('osc2Type', { required: true });
const osc2Coarse = defineModel<number>('osc2Coarse', { required: true });
const osc2Fine = defineModel<number>('osc2Fine', { required: true });
</script>

<style scoped>
.module-group { background: #222; padding: 15px; border-radius: 8px; }
h3 { margin-top: 0; color: #888; border-bottom: 1px solid #333; padding-bottom: 5px; }
.osc-row { display: flex; flex-direction: column; gap: 12px; }
.osc-unit { background: #333; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; }
.osc-unit h4 { margin: 0 0 10px 0; font-size: 0.8rem; color: #888; }
.osc-knobs { display: flex; gap: 15px; }
select { background: #000; color: #fff; border: 1px solid #444; padding: 5px; margin-bottom: 10px; border-radius: 3px; }
</style>
