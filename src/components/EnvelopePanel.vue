<template>
  <div v-if="(type === 'filter' || type === 'both') && filterEnv" class="module-group">
    <h3>
      Filter Env
      <span
        v-if="filterEnvExceedsNote"
        class="env-warning"
        :title="warningTitle('filter')"
      >⚠</span>
    </h3>
    <div class="knob-row">
      <Knob label="A" :min="0" :max="2" :step="0.01" format="ms" v-model="filterEnv.a" />
      <Knob label="D" :min="0" :max="2" :step="0.01" format="ms" v-model="filterEnv.d" />
      <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" v-model="filterEnv.s" />
      <Knob label="R" :min="0" :max="5" :step="0.01" format="ms" v-model="filterEnv.r" />
    </div>
  </div>

  <div v-if="(type === 'amp' || type === 'both') && ampEnv" class="module-group">
    <h3>
      Amp Env
      <span
        v-if="ampEnvExceedsNote"
        class="env-warning"
        :title="warningTitle('amp')"
      >⚠</span>
    </h3>
    <div class="knob-row">
      <Knob label="A" :min="0" :max="2" :step="0.01" format="ms" v-model="ampEnv.a" />
      <Knob label="D" :min="0" :max="2" :step="0.01" format="ms" v-model="ampEnv.d" />
      <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" v-model="ampEnv.s" />
      <Knob label="R" :min="0" :max="5" :step="0.01" format="ms" v-model="ampEnv.r" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Knob from './Knob.vue';

const props = withDefaults(
  defineProps<{
    type?: 'filter' | 'amp' | 'both';
    filterEnv?: { a: number; d: number; s: number; r: number };
    ampEnv?: { a: number; d: number; s: number; r: number };
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
  if (!props.ampEnv || props.shortestActiveNoteDuration == null) return false;
  return props.ampEnv.a + props.ampEnv.d > props.shortestActiveNoteDuration;
});

const filterEnvExceedsNote = computed(() => {
  if (!props.filterEnv || props.shortestActiveNoteDuration == null) return false;
  return props.filterEnv.a + props.filterEnv.d > props.shortestActiveNoteDuration;
});

const formatSeconds = (s: number) => s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`;

const warningTitle = (kind: 'filter' | 'amp') => {
  const env = kind === 'amp' ? props.ampEnv : props.filterEnv;
  if (!env || props.shortestActiveNoteDuration == null) return '';
  const ad = formatSeconds(env.a + env.d);
  const note = formatSeconds(props.shortestActiveNoteDuration);
  return `A+D (${ad}) exceeds shortest active note (${note}). The envelope never reaches sustain — release starts mid-curve.`;
};
</script>

<style scoped>
.knob-row { display: flex; gap: 10px; flex-wrap: nowrap; }
.env-warning {
  color: #fb923c;
  margin-left: 8px;
  font-size: 0.85rem;
  cursor: help;
  user-select: none;
}
</style>
