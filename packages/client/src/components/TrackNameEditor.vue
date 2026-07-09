<!--
  Click-to-edit track name (focused-view header). Shows the resolved display
  label when idle; click swaps in a text input prefilled with the RAW custom
  name ('' when unnamed). Enter/blur commit the trimmed draft ('' = revert to
  the `Track N` default); Escape cancels. The parent owns persistence — this
  component only emits.
-->
<template>
  <span
    v-if="!editing"
    class="track-name-label"
    title="Click to rename"
    @click="beginEdit"
  >{{ displayName }}</span>
  <input
    v-else
    ref="inputEl"
    v-model="draft"
    class="track-name-input"
    type="text"
    :maxlength="TRACK_NAME_MAX_LENGTH"
    @keydown.enter.prevent="commit"
    @keydown.esc.prevent="cancel"
    @blur="commit"
  />
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { TRACK_NAME_MAX_LENGTH } from '@fiddle/shared';

const props = defineProps<{
  // Raw custom name ('' = unnamed) — what the editor prefills with.
  name: string;
  // Resolved label (custom name or `Track N` fallback) — what idle shows.
  displayName: string;
}>();

const emit = defineEmits<{ commit: [value: string] }>();

const editing = ref(false);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

async function beginEdit(): Promise<void> {
  draft.value = props.name;
  editing.value = true;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
}

function commit(): void {
  // Enter commits then the input unmounts and fires blur; Escape flips
  // `editing` before its blur too — this guard makes both single-shot.
  if (!editing.value) return;
  editing.value = false;
  emit('commit', draft.value.trim());
}

function cancel(): void {
  editing.value = false; // no emit; the commit() guard swallows the blur
}
</script>

<style scoped>
.track-name-label {
  cursor: text;
  border-bottom: 1px dotted transparent;
}
.track-name-label:hover {
  border-bottom-color: currentColor;
}
.track-name-input {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid currentColor;
  border-radius: 3px;
  color: inherit;
  font: inherit;
  padding: 0 6px;
  width: 14ch;
}
.track-name-input:focus {
  outline: none;
}
</style>
