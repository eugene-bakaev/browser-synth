<template>
  <div class="module-group">
    <h3>Oscillators</h3>
    <div class="osc-row">
      <div class="osc-unit">
        <h4>OSC 1</h4>
        <select :value="params.osc1Type" @change="ks.set('osc1Type', ($event.target as HTMLSelectElement).value)">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" :defaultValue="DEFAULTS.osc1Coarse" format="octave" :modelValue="params.osc1Coarse" @update:modelValue="ks.set('osc1Coarse', $event)" :syncPath="ks.pathFor('osc1Coarse')" @gesture-end="ks.end('osc1Coarse')" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" :defaultValue="DEFAULTS.osc1Fine" format="cents" :modelValue="params.osc1Fine" @update:modelValue="ks.set('osc1Fine', $event)" :syncPath="ks.pathFor('osc1Fine')" @gesture-end="ks.end('osc1Fine')" />
          <Knob v-if="params.osc1Type === 'square'" label="Pulse" :min="0.05" :max="0.95" :step="0.01" :defaultValue="DEFAULTS.osc1PulseWidth" format="percent" :modelValue="params.osc1PulseWidth" @update:modelValue="ks.set('osc1PulseWidth', $event)" :syncPath="ks.pathFor('osc1PulseWidth')" @gesture-end="ks.end('osc1PulseWidth')" />
        </div>
      </div>
      <div class="osc-unit">
        <h4>OSC 2</h4>
        <select :value="params.osc2Type" @change="ks.set('osc2Type', ($event.target as HTMLSelectElement).value)">
          <option v-for="t in waveforms" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="osc-knobs">
          <Knob label="Coarse" :min="-3" :max="3" :step="1" :defaultValue="DEFAULTS.osc2Coarse" format="octave" :modelValue="params.osc2Coarse" @update:modelValue="ks.set('osc2Coarse', $event)" :syncPath="ks.pathFor('osc2Coarse')" @gesture-end="ks.end('osc2Coarse')" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" :defaultValue="DEFAULTS.osc2Fine" format="cents" :modelValue="params.osc2Fine" @update:modelValue="ks.set('osc2Fine', $event)" :syncPath="ks.pathFor('osc2Fine')" @gesture-end="ks.end('osc2Fine')" />
          <Knob v-if="params.osc2Type === 'square'" label="Pulse" :min="0.05" :max="0.95" :step="0.01" :defaultValue="DEFAULTS.osc2PulseWidth" format="percent" :modelValue="params.osc2PulseWidth" @update:modelValue="ks.set('osc2PulseWidth', $event)" :syncPath="ks.pathFor('osc2PulseWidth')" @gesture-end="ks.end('osc2PulseWidth')" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

defineProps<{
  params: EngineParamsMap['synth'];
  // OscillatorTypeLiteral is the 4-waveform union shared with the engine
  // (excludes DOM's 'custom', which we never use).
  waveforms: OscillatorTypeLiteral[];
}>();
</script>

<style scoped>
.osc-row { display: flex; flex-direction: column; gap: 12px; }
.osc-unit { background: #333; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; }
.osc-unit h4 { margin: 0 0 10px 0; font-size: 0.8rem; color: #888; }
.osc-knobs { display: flex; gap: 15px; }
select { background: #000; color: #fff; border: 1px solid #444; padding: 5px; margin-bottom: 10px; border-radius: 3px; }
</style>
