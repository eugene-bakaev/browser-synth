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
        <button type="button" class="loop-btn" :class="{ active: params.env1.loop }" @click="params.env1.loop = !params.env1.loop">LOOP</button>
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
        <button
          type="button"
          class="sync-btn"
          :class="{ active: params.osc2.sync }"
          @click="params.osc2.sync = !params.osc2.sync"
        >
          SYNC
        </button>
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
        <button
          type="button"
          class="sync-btn"
          :class="{ active: params.osc3.sync }"
          @click="params.osc3.sync = !params.osc3.sync"
        >
          SYNC
        </button>
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

    <!-- Column 5: Filter -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>FILTER</h3>
        <div class="filter-model-selector">
          <button type="button" class="filter-model-btn to-classic" :class="{ active: params.filter.model === 'classic' }" @click="params.filter.model = 'classic'">CLASSIC</button>
          <button type="button" class="filter-model-btn to-morph" :class="{ active: params.filter.model === 'morph' }" @click="params.filter.model = 'morph'">MORPH</button>
        </div>
        <div v-if="params.filter.model === 'classic'" class="filter-type-selector">
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'lp' }" @click="params.filter.type = 'lp'">LP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'bp' }" @click="params.filter.type = 'bp'">BP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'hp' }" @click="params.filter.type = 'hp'">HP</button>
        </div>
        <div v-else class="knob-row">
          <Knob label="Morph" :min="0" :max="2" :step="0.01" :defaultValue="DEFAULTS.filter.morph" v-model="params.filter.morph" :syncPath="ks.pathFor(['filter', 'morph'])" @gesture-end="ks.end(['filter', 'morph'])" />
        </div>
        <div class="knob-row">
          <Knob label="Cutoff" :min="20" :max="20000" :step="1" format="hz" :defaultValue="DEFAULTS.filter.cutoff" v-model="params.filter.cutoff" :syncPath="ks.pathFor(['filter', 'cutoff'])" @gesture-end="ks.end(['filter', 'cutoff'])" />
          <Knob label="Res" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.filter.resonance" v-model="params.filter.resonance" :syncPath="ks.pathFor(['filter', 'resonance'])" @gesture-end="ks.end(['filter', 'resonance'])" />
          <Knob label="KeyTrk" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.filter.keyTrack" v-model="params.filter.keyTrack" :syncPath="ks.pathFor(['filter', 'keyTrack'])" @gesture-end="ks.end(['filter', 'keyTrack'])" />
          <Knob label="EnvAmt" :min="-4" :max="4" :step="0.1" :defaultValue="DEFAULTS.filter.envAmount" v-model="params.filter.envAmount" :syncPath="ks.pathFor(['filter', 'envAmount'])" @gesture-end="ks.end(['filter', 'envAmount'])" />
        </div>
      </div>
    </div>

    <!-- Column 6: Filter envelope (env2) -->
    <div class="rack-column">
      <div class="module-group">
        <h3>FILTER ENV</h3>
        <div class="knob-row">
          <Knob label="A" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env2.a" v-model="params.env2.a" :syncPath="ks.pathFor(['env2', 'a'])" @gesture-end="ks.end(['env2', 'a'])" />
          <Knob label="D" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env2.d" v-model="params.env2.d" :syncPath="ks.pathFor(['env2', 'd'])" @gesture-end="ks.end(['env2', 'd'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env2.s" v-model="params.env2.s" :syncPath="ks.pathFor(['env2', 's'])" @gesture-end="ks.end(['env2', 's'])" />
          <Knob label="R" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env2.r" v-model="params.env2.r" :syncPath="ks.pathFor(['env2', 'r'])" @gesture-end="ks.end(['env2', 'r'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env2.loop }" @click="params.env2.loop = !params.env2.loop">LOOP</button>
      </div>
    </div>

    <!-- Column 7: Mod envelope (env3) -->
    <div class="rack-column">
      <div class="module-group">
        <h3>ENV 3</h3>
        <div class="knob-row">
          <Knob label="A" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env3.a" v-model="params.env3.a" :syncPath="ks.pathFor(['env3', 'a'])" @gesture-end="ks.end(['env3', 'a'])" />
          <Knob label="D" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env3.d" v-model="params.env3.d" :syncPath="ks.pathFor(['env3', 'd'])" @gesture-end="ks.end(['env3', 'd'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env3.s" v-model="params.env3.s" :syncPath="ks.pathFor(['env3', 's'])" @gesture-end="ks.end(['env3', 's'])" />
          <Knob label="R" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env3.r" v-model="params.env3.r" :syncPath="ks.pathFor(['env3', 'r'])" @gesture-end="ks.end(['env3', 'r'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env3.loop }" @click="params.env3.loop = !params.env3.loop">LOOP</button>
      </div>
    </div>

    <!-- Column 8: LFOs -->
    <div class="rack-column">
      <div class="module-group">
        <h3>LFO 1</h3>
        <div class="knob-row">
          <Knob label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" :defaultValue="DEFAULTS.lfo1.rate" v-model="params.lfo1.rate" :syncPath="ks.pathFor(['lfo1', 'rate'])" @gesture-end="ks.end(['lfo1', 'rate'])" />
          <Knob label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo1.shape" v-model="params.lfo1.shape" :syncPath="ks.pathFor(['lfo1', 'shape'])" @gesture-end="ks.end(['lfo1', 'shape'])" />
        </div>
      </div>
      <div class="module-group">
        <h3>LFO 2</h3>
        <div class="knob-row">
          <Knob label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" :defaultValue="DEFAULTS.lfo2.rate" v-model="params.lfo2.rate" :syncPath="ks.pathFor(['lfo2', 'rate'])" @gesture-end="ks.end(['lfo2', 'rate'])" />
          <Knob label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo2.shape" v-model="params.lfo2.shape" :syncPath="ks.pathFor(['lfo2', 'shape'])" @gesture-end="ks.end(['lfo2', 'shape'])" />
        </div>
      </div>
    </div>

    <!-- Column 9: Mod matrix -->
    <div class="rack-column">
      <div class="module-group">
        <h3>MATRIX</h3>
        <div class="matrix-grid">
          <div v-for="(slot, s) in params.matrix" :key="s" class="matrix-row">
            <select class="matrix-source" v-model="slot.source">
              <option v-for="src in MOD_SOURCES" :key="src" :value="src">{{ src }}</option>
            </select>
            <select class="matrix-dest" v-model="slot.dest">
              <option v-for="dst in MOD_DESTS" :key="dst" :value="dst">{{ dst }}</option>
            </select>
            <Knob label="Amt" :min="-1" :max="1" :step="0.01" :defaultValue="0" v-model="slot.amount" :syncPath="ks.pathFor(['matrix', s, 'amount'])" @gesture-end="ks.end(['matrix', s, 'amount'])" />
          </div>
        </div>
      </div>
    </div>

    <!-- Column 10: Visualizer -->
    <div class="rack-column">
      <Visualizer :analyser="analyser" :color="color" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import { Synth2Engine } from '../engine/Synth2Engine';
import { MOD_SOURCES, MOD_DESTS } from '@fiddle/shared';
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
.sync-btn,
.loop-btn {
  width: 100%;
  margin-top: 6px;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 10px;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.sync-btn:hover,
.loop-btn:hover { color: #aaa; border-color: #444; }
.sync-btn.active,
.loop-btn.active { background: #222; color: #fff; border-color: #555; }
.filter-type-selector {
  display: flex;
  gap: 6px;
  width: 100%;
  margin-bottom: 8px;
}
.filter-type-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 0;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.filter-type-btn:hover { color: #aaa; border-color: #444; }
.filter-type-btn.active { background: #222; color: #fff; border-color: #555; }
.filter-model-selector { display: flex; gap: 4px; margin-bottom: 6px; }
.filter-model-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 0;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.filter-model-btn:hover { color: #aaa; border-color: #444; }
.filter-model-btn.active { background: #222; color: #fff; border-color: #555; }
.matrix-grid { display: flex; flex-direction: column; gap: 4px; }
.matrix-row { display: flex; align-items: center; gap: 4px; }
.matrix-row select {
  flex: 1; min-width: 0; background: #181818; color: #aaa;
  border: 1px solid #2a2a2a; border-radius: 4px; padding: 3px 4px;
  font-family: monospace; font-size: 0.65rem;
}
</style>
