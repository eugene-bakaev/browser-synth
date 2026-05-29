<template>
  <div class="module-group">
    <h3>Mixer</h3>
    <div class="knob-row">
      <Knob label="OSC 1 Level" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.osc1Level" format="percent" v-model="osc1Level" :syncPath="ks.pathFor('osc1Level')" @gesture-end="ks.end('osc1Level')" />
      <Knob label="OSC 2 Level" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.osc2Level" format="percent" v-model="osc2Level" :syncPath="ks.pathFor('osc2Level')" @gesture-end="ks.end('osc2Level')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

const osc1Level = defineModel<number>('osc1Level', { required: true });
const osc2Level = defineModel<number>('osc2Level', { required: true });
</script>


