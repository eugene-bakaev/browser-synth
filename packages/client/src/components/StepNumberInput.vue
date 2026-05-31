<template>
  <input
    type="number"
    :value="draft"
    :min="min"
    :max="max"
    :disabled="disabled"
    :title="title"
    @input="draft = ($event.target as HTMLInputElement).value"
    @change="commit"
    @blur="commit"
  >
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { clampStepField } from '../utils/stepFields';

// A draft-backed number input for live, reactive step values (OCT / LEN).
//
// `draft` is a string the field owns while you type, so playback re-renders —
// which re-apply `:value` ~8×/sec — reflect what you typed instead of clobbering
// it. The committed value only changes on change/blur, parsed and clamped via
// clampStepField. Mirrors the pattern-length field's lengthDraft/commitLength.
const props = defineProps<{
  modelValue: number;
  min: number;
  max: number;
  disabled?: boolean;
  title?: string;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>();

const draft = ref(String(props.modelValue));

// Resync when the value changes externally (remote sync op, or our own clamp).
watch(() => props.modelValue, (v) => { draft.value = String(v); });

const commit = () => {
  const next = clampStepField(draft.value, props.min, props.max, props.modelValue);
  draft.value = String(next); // reflect the clamp/fallback in the field
  if (next !== props.modelValue) emit('update:modelValue', next);
};
</script>
