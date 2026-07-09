<template>
  <div v-if="type === 'filter' || type === 'both'" class="module-group">
    <h3>
      Filter Env
      <span
        v-if="filterEnvExceedsNote"
        class="env-warning"
        :title="warningTitle('filter')"
      >⚠</span>
    </h3>
    <div class="knob-row">
      <Knob label="A" :min="0.001" :max="2" :step="0.001" :defaultValue="DEFAULTS.filterEnv.a" format="ms" :modelValue="params.filterEnv.a" @update:modelValue="ks.set(['filterEnv','a'], $event)" :syncPath="ks.pathFor(['filterEnv','a'])" @gesture-end="ks.end(['filterEnv','a'])" />
      <Knob label="D" :min="0.001" :max="2" :step="0.001" :defaultValue="DEFAULTS.filterEnv.d" format="ms" :modelValue="params.filterEnv.d" @update:modelValue="ks.set(['filterEnv','d'], $event)" :syncPath="ks.pathFor(['filterEnv','d'])" @gesture-end="ks.end(['filterEnv','d'])" />
      <Knob label="S" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.filterEnv.s" format="percent" :modelValue="params.filterEnv.s" @update:modelValue="ks.set(['filterEnv','s'], $event)" :syncPath="ks.pathFor(['filterEnv','s'])" @gesture-end="ks.end(['filterEnv','s'])" />
      <Knob label="R" :min="0.001" :max="5" :step="0.001" :defaultValue="DEFAULTS.filterEnv.r" format="ms" :modelValue="params.filterEnv.r" @update:modelValue="ks.set(['filterEnv','r'], $event)" :syncPath="ks.pathFor(['filterEnv','r'])" @gesture-end="ks.end(['filterEnv','r'])" />
    </div>
  </div>

  <div v-if="type === 'amp' || type === 'both'" class="module-group">
    <h3>
      Amp Env
      <span
        v-if="ampEnvExceedsNote"
        class="env-warning"
        :title="warningTitle('amp')"
      >⚠</span>
    </h3>
    <div class="knob-row">
      <Knob label="A" :min="0.001" :max="2" :step="0.001" :defaultValue="DEFAULTS.ampEnv.a" format="ms" :modelValue="params.ampEnv.a" @update:modelValue="ks.set(['ampEnv','a'], $event)" :syncPath="ks.pathFor(['ampEnv','a'])" @gesture-end="ks.end(['ampEnv','a'])" />
      <Knob label="D" :min="0.001" :max="2" :step="0.001" :defaultValue="DEFAULTS.ampEnv.d" format="ms" :modelValue="params.ampEnv.d" @update:modelValue="ks.set(['ampEnv','d'], $event)" :syncPath="ks.pathFor(['ampEnv','d'])" @gesture-end="ks.end(['ampEnv','d'])" />
      <Knob label="S" :min="0" :max="1" :step="0.01" :defaultValue="DEFAULTS.ampEnv.s" format="percent" :modelValue="params.ampEnv.s" @update:modelValue="ks.set(['ampEnv','s'], $event)" :syncPath="ks.pathFor(['ampEnv','s'])" @gesture-end="ks.end(['ampEnv','s'])" />
      <Knob label="R" :min="0.001" :max="5" :step="0.001" :defaultValue="DEFAULTS.ampEnv.r" format="ms" :modelValue="params.ampEnv.r" @update:modelValue="ks.set(['ampEnv','r'], $event)" :syncPath="ks.pathFor(['ampEnv','r'])" @gesture-end="ks.end(['ampEnv','r'])" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Knob from './Knob.vue';
import { SynthEngine } from '../engine/SynthEngine';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = SynthEngine.DEFAULT_PARAMS;
const ks = useKnobSync('synth');

const props = withDefaults(
  defineProps<{
    type?: 'filter' | 'amp' | 'both';
    params: EngineParamsMap['synth'];
    // Duration in seconds of the shortest non-muted note on the active track.
    // null when no notes are active (no warning shown).
    shortestActiveNoteDuration?: number | null;
  }>(),
  {
    type: 'both',
    shortestActiveNoteDuration: null,
  }
);

// An envelope is "truncated" when A+D exceeds the note length — the note never
// reaches its sustain level before release kicks in.
const ampEnvExceedsNote = computed(() => {
  if (props.shortestActiveNoteDuration == null) return false;
  return props.params.ampEnv.a + props.params.ampEnv.d > props.shortestActiveNoteDuration;
});

const filterEnvExceedsNote = computed(() => {
  if (props.shortestActiveNoteDuration == null) return false;
  return props.params.filterEnv.a + props.params.filterEnv.d > props.shortestActiveNoteDuration;
});

const formatSeconds = (s: number) => `${Math.round(s * 1000)}ms`;

const warningTitle = (kind: 'filter' | 'amp') => {
  const env = kind === 'amp' ? props.params.ampEnv : props.params.filterEnv;
  if (props.shortestActiveNoteDuration == null) return '';
  const ad = formatSeconds(env.a + env.d);
  const note = formatSeconds(props.shortestActiveNoteDuration);
  return `A+D (${ad}) exceeds shortest active note (${note}). The envelope never reaches sustain — release starts mid-curve.`;
};
</script>

<style scoped>
.env-warning {
  color: #fb923c;
  margin-left: 8px;
  font-size: 0.85rem;
  cursor: help;
  user-select: none;
}
</style>
