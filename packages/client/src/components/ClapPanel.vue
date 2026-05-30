<template>
  <div class="rack-columns">
    <!-- Column 1: Drum Controls -->
    <div class="rack-column">
      <div class="module-group clap-panel">
        <h3>Clap Machine</h3>
        <div class="knob-row">
          <Knob label="Decay" :min="0.05" :max="0.8" :step="0.01" :defaultValue="DEFAULTS.decay" format="ms" v-model="params.decay" :syncPath="ks.pathFor('decay')" @gesture-end="ks.end('decay')" />
          <Knob label="Tone" :min="500" :max="3000" :step="10" :defaultValue="DEFAULTS.tone" format="hz" v-model="params.tone" :syncPath="ks.pathFor('tone')" @gesture-end="ks.end('tone')" />
          <Knob label="Sloppy" :min="0.005" :max="0.03" :step="0.001" :defaultValue="DEFAULTS.sloppy" format="ms" v-model="params.sloppy" :syncPath="ks.pathFor('sloppy')" @gesture-end="ks.end('sloppy')" />
        </div>
      </div>
    </div>
    
    <!-- Column 2: Visualizer -->
    <div class="rack-column">
      <Visualizer :analyser="analyser" :color="color" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { ClapEngine } from '../engine/ClapEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = ClapEngine.DEFAULT_PARAMS;
const ks = useKnobSync('clap');

defineProps<{
  params: EngineParamsMap['clap'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>


