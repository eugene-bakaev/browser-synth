<template>
  <div class="rack-columns">
    <!-- Mono/Poly toggle -->
    <div class="synth-mode-selector">
      <button
        type="button"
        class="mode-btn"
        :class="{ active: params.mode === 'mono' }"
        @click="params.mode = 'mono'"
      >
        MONO
      </button>
      <button
        type="button"
        class="mode-btn"
        :class="{ active: params.mode === 'poly' }"
        @click="params.mode = 'poly'"
      >
        POLY
      </button>
    </div>

    <!-- Column 1: Oscillator 1 -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>OSC 1</h3>
        <div class="knob-row">
          <Knob label="Morph" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc1.morph" v-model="params.osc1.morph" :syncPath="ks.pathFor(['osc1', 'morph'])" @gesture-end="ks.end(['osc1', 'morph'])" />
          <Knob label="PW" :min="0.05" :max="0.95" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc1.pulseWidth" v-model="params.osc1.pulseWidth" :syncPath="ks.pathFor(['osc1', 'pulseWidth'])" @gesture-end="ks.end(['osc1', 'pulseWidth'])" />
          <Knob label="Coarse" :min="-36" :max="36" :step="1" :defaultValue="DEFAULTS.osc1.coarse" v-model="params.osc1.coarse" :syncPath="ks.pathFor(['osc1', 'coarse'])" @gesture-end="ks.end(['osc1', 'coarse'])" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" format="cents" :defaultValue="DEFAULTS.osc1.fine" v-model="params.osc1.fine" :syncPath="ks.pathFor(['osc1', 'fine'])" @gesture-end="ks.end(['osc1', 'fine'])" />
          <Knob label="Level" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc1.level" v-model="params.osc1.level" :syncPath="ks.pathFor(['osc1', 'level'])" @gesture-end="ks.end(['osc1', 'level'])" />
        </div>
      </div>
      <div class="module-group">
        <h3>AMP ENV</h3>
        <div class="knob-row">
          <Knob label="A" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.a" v-model="params.env1.a" :syncPath="ks.pathFor(['env1', 'a'])" @gesture-end="ks.end(['env1', 'a'])" />
          <Knob label="D" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.d" v-model="params.env1.d" :syncPath="ks.pathFor(['env1', 'd'])" @gesture-end="ks.end(['env1', 'd'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env1.s" v-model="params.env1.s" :syncPath="ks.pathFor(['env1', 's'])" @gesture-end="ks.end(['env1', 's'])" />
          <Knob label="R" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.r" v-model="params.env1.r" :syncPath="ks.pathFor(['env1', 'r'])" @gesture-end="ks.end(['env1', 'r'])" />
        </div>
      </div>
    </div>

    <!-- Column 2: Oscillator 2 -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>OSC 2</h3>
        <div class="knob-row">
          <Knob label="Morph" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc2.morph" v-model="params.osc2.morph" :syncPath="ks.pathFor(['osc2', 'morph'])" @gesture-end="ks.end(['osc2', 'morph'])" />
          <Knob label="PW" :min="0.05" :max="0.95" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc2.pulseWidth" v-model="params.osc2.pulseWidth" :syncPath="ks.pathFor(['osc2', 'pulseWidth'])" @gesture-end="ks.end(['osc2', 'pulseWidth'])" />
          <Knob label="Coarse" :min="-36" :max="36" :step="1" :defaultValue="DEFAULTS.osc2.coarse" v-model="params.osc2.coarse" :syncPath="ks.pathFor(['osc2', 'coarse'])" @gesture-end="ks.end(['osc2', 'coarse'])" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" format="cents" :defaultValue="DEFAULTS.osc2.fine" v-model="params.osc2.fine" :syncPath="ks.pathFor(['osc2', 'fine'])" @gesture-end="ks.end(['osc2', 'fine'])" />
          <Knob label="Level" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc2.level" v-model="params.osc2.level" :syncPath="ks.pathFor(['osc2', 'level'])" @gesture-end="ks.end(['osc2', 'level'])" />
        </div>
      </div>
    </div>

    <!-- Column 3: Oscillator 3 -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>OSC 3</h3>
        <div class="knob-row">
          <Knob label="Morph" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc3.morph" v-model="params.osc3.morph" :syncPath="ks.pathFor(['osc3', 'morph'])" @gesture-end="ks.end(['osc3', 'morph'])" />
          <Knob label="PW" :min="0.05" :max="0.95" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc3.pulseWidth" v-model="params.osc3.pulseWidth" :syncPath="ks.pathFor(['osc3', 'pulseWidth'])" @gesture-end="ks.end(['osc3', 'pulseWidth'])" />
          <Knob label="Coarse" :min="-36" :max="36" :step="1" :defaultValue="DEFAULTS.osc3.coarse" v-model="params.osc3.coarse" :syncPath="ks.pathFor(['osc3', 'coarse'])" @gesture-end="ks.end(['osc3', 'coarse'])" />
          <Knob label="Fine" :min="-100" :max="100" :step="1" format="cents" :defaultValue="DEFAULTS.osc3.fine" v-model="params.osc3.fine" :syncPath="ks.pathFor(['osc3', 'fine'])" @gesture-end="ks.end(['osc3', 'fine'])" />
          <Knob label="Level" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc3.level" v-model="params.osc3.level" :syncPath="ks.pathFor(['osc3', 'level'])" @gesture-end="ks.end(['osc3', 'level'])" />
        </div>
      </div>
    </div>

    <!-- Column 4: Noise + FM -->
    <div class="rack-column">
      <div class="module-group">
        <h3>NOISE</h3>
        <div class="knob-row">
          <Knob label="Level" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.noise.level" v-model="params.noise.level" :syncPath="ks.pathFor(['noise', 'level'])" @gesture-end="ks.end(['noise', 'level'])" />
          <Knob label="Color" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.noise.color" v-model="params.noise.color" :syncPath="ks.pathFor(['noise', 'color'])" @gesture-end="ks.end(['noise', 'color'])" />
        </div>
      </div>
      <div class="module-group">
        <h3>FM</h3>
        <div class="knob-row">
          <Knob label="FM 1→2" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.fm.osc2" v-model="params.fm.osc2" :syncPath="ks.pathFor(['fm', 'osc2'])" @gesture-end="ks.end(['fm', 'osc2'])" />
          <Knob label="FM 2→3" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.fm.osc3" v-model="params.fm.osc3" :syncPath="ks.pathFor(['fm', 'osc3'])" @gesture-end="ks.end(['fm', 'osc3'])" />
        </div>
      </div>
    </div>

    <!-- Column 5: Visualizer -->
    <div class="rack-column">
      <Visualizer :analyser="analyser" :color="color" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { Synth2Engine } from '../engine/Synth2Engine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = Synth2Engine.DEFAULT_PARAMS;
const ks = useKnobSync('synth2');

defineProps<{
  params: EngineParamsMap['synth2'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>

<style scoped>
.synth-mode-selector {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-bottom: 5px;
}
.synth-mode-selector .mode-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 6px 12px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.synth-mode-selector .mode-btn:hover {
  color: #aaa;
  border-color: #444;
}
.synth-mode-selector .mode-btn.active {
  background: #222;
  color: #fff;
  border-color: #555;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}
</style>
