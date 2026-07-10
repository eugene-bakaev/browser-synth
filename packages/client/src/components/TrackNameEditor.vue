<!--
  Click-to-edit track name (focused-view header). Shows the resolved display
  label when idle; click swaps in a text input prefilled with the RAW custom
  name ('' when unnamed). Enter/blur commit the trimmed draft ('' = revert to
  the `Track N` default); Escape cancels. The parent owns persistence — this
  component only emits.
-->
<template>
  <span v-if="!editing" class="track-name-idle">
    <span
      class="track-name-label"
      title="Click to rename"
      @click="beginEdit"
    >{{ displayName }}</span>
    <button
      class="rename-btn"
      type="button"
      title="Rename track"
      aria-label="Rename track"
      @click="beginEdit"
    >✎</button>
  </span>
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
  const trimmed = draft.value.trim();
  // No-op guard: click-name-then-click-away without typing shouldn't dispatch
  // an unchanged value as a sync op.
  if (trimmed === props.name) return;
  emit('commit', trimmed);
}

function cancel(): void {
  editing.value = false; // no emit; the commit() guard swallows the blur
}

// Lets the parent start editing from other affordances (e.g. clicking the
// focused Tracker's title).
defineExpose({ beginEdit });
</script>

<style scoped>
.track-name-label {
  cursor: text;
  /* Always-visible affordance: the dotted underline marks the name editable. */
  border-bottom: 1px dotted currentColor;
  text-transform: none; /* Shield custom name from inherited header uppercase */
}
.rename-btn {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 0.8em;
  opacity: 0.6;
  padding: 0 2px;
}
.rename-btn:hover {
  opacity: 1;
}
.track-name-input {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid currentColor;
  border-radius: 3px;
  color: inherit;
  font: inherit;
  padding: 0 6px;
  width: 14ch;
  text-transform: none; /* Shield custom name from inherited header uppercase */
}
.track-name-input:focus {
  outline: none;
}
</style>
