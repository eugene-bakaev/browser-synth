<template>
  <div class="backdrop" @click.self="onBackdrop">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="ariaLabel ?? title">
      <h3 v-if="title">{{ title }}</h3>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

// The shared modal shell: backdrop + centered dialog box. Owns only the chrome
// (backdrop, box, title); the contents come from the slot and are styled by the
// parent (slotted content renders in the parent's scope, not this one).
const props = defineProps<{
  title?: string;
  ariaLabel?: string;
  // Clicking the backdrop emits close by default; pass false to require an
  // explicit in-dialog choice (e.g. a confirm the user must answer).
  closeOnBackdrop?: boolean;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

function onBackdrop(): void {
  if (props.closeOnBackdrop !== false) emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; }
.dialog { width: 420px; max-width: calc(100vw - 32px); background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.dialog h3 { margin: 0; font-family: monospace; text-transform: uppercase; letter-spacing: 0.06em; color: #ddd; }
</style>
