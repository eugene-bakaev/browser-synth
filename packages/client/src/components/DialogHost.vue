<template>
  <BaseModal
    v-if="dialog"
    :title="dialog.title"
    :aria-label="dialog.title ?? (dialog.variant === 'alert' ? 'Alert' : 'Confirm')"
    :close-on-backdrop="dialog.variant === 'alert'"
    @close="onClose"
  >
    <p class="message">{{ dialog.message }}</p>
    <input
      v-if="dialog.variant === 'prompt'"
      v-model="promptDraft"
      class="prompt-input"
      :placeholder="dialog.placeholder ?? ''"
      @keyup.enter="resolveActiveDialog(true)"
      autofocus
    />
    <div class="actions">
      <button v-if="dialog.variant === 'confirm' || dialog.variant === 'prompt'" class="btn" @click="resolveActiveDialog(false)">
        {{ dialog.cancelLabel ?? 'Cancel' }}
      </button>
      <button class="btn primary" :class="{ danger: dialog.danger }" @click="resolveActiveDialog(true)">
        {{ dialog.confirmLabel ?? (dialog.variant === 'alert' ? 'OK' : 'Confirm') }}
      </button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import BaseModal from './BaseModal.vue';
import { activeDialog, resolveActiveDialog, promptDraft } from '../dialogs/useDialog';

const dialog = activeDialog;

// Escape / backdrop dismiss: an alert is simply acknowledged; a confirm/prompt cancels.
function onClose(): void {
  resolveActiveDialog(dialog.value?.variant === 'alert');
}
</script>

<style scoped>
.message { margin: 0; color: #ddd; font-size: 0.9rem; line-height: 1.5; }
.prompt-input { width: 100%; box-sizing: border-box; margin-top: 10px; padding: 8px 10px; border-radius: 6px; border: 1px solid #444; background: #1a1a1a; color: #ddd; font-size: 0.9rem; outline: none; }
.prompt-input:focus { border-color: #00f0ff; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.btn { font-size: 0.85rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; cursor: pointer; }
.btn.primary { border-color: #00f0ff; color: #00f0ff; }
.btn.primary.danger { border-color: #FF4136; color: #FF4136; }
.btn:disabled { opacity: 0.5; cursor: default; }
</style>
