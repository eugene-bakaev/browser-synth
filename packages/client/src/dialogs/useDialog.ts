import { computed, ref } from 'vue';

// A promise-based replacement for the browser's native confirm()/alert().
// Calling code awaits a result; a single <DialogHost> (mounted once at the app
// root) renders the active request. Multiple requests queue and show in turn,
// so two near-simultaneous prompts don't clobber each other.

export type DialogVariant = 'confirm' | 'alert';

export interface DialogOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // Render the confirm button in a destructive (red) style.
  danger?: boolean;
}

interface DialogRequest extends DialogOptions {
  variant: DialogVariant;
  resolve: (ok: boolean) => void;
}

const queue = ref<DialogRequest[]>([]);

// The request currently shown (front of the queue), or null when idle.
export const activeDialog = computed<DialogRequest | null>(() => queue.value[0] ?? null);

// Called by DialogHost when the user answers (or dismisses). Resolves the
// pending promise and advances the queue.
export function resolveActiveDialog(ok: boolean): void {
  const current = queue.value[0];
  if (!current) return;
  current.resolve(ok);
  queue.value = queue.value.slice(1);
}

function enqueue(opts: DialogOptions, variant: DialogVariant): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.value = [...queue.value, { ...opts, variant, resolve }];
  });
}

export function useDialog() {
  return {
    // Resolves true if confirmed, false if cancelled/dismissed.
    confirm(input: string | DialogOptions): Promise<boolean> {
      const opts = typeof input === 'string' ? { message: input } : input;
      return enqueue(opts, 'confirm');
    },
    // Resolves once the user acknowledges.
    alert(input: string | DialogOptions): Promise<void> {
      const opts = typeof input === 'string' ? { message: input } : input;
      return enqueue(opts, 'alert').then(() => undefined);
    },
  };
}
