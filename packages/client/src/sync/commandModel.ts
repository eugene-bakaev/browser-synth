// useCommandModel — a v-model adapter that routes a control's writes through
// the command bus instead of mutating `project` directly.
//
// The returned writable computed reads the live value at `path` from the
// canonical project (reactively, so the control stays in sync with remote
// edits) and, on write, dispatches a local `set` command via dispatchLocal.
// `path` may be a thunk so a loop-bound control (a step cell, a mixer channel)
// can compute its path per render.

import { computed, inject, type WritableComputedRef } from 'vue';
import { getDeep, type Path } from '@fiddle/shared';
import { SYNTH_CONTEXT } from '../app/synthContext';

export function useCommandModel<T = unknown>(
  path: Path | (() => Path),
): WritableComputedRef<T> {
  const synth = inject(SYNTH_CONTEXT);
  if (!synth) throw new Error('useCommandModel requires SYNTH_CONTEXT (provided by App)');
  const resolve = typeof path === 'function' ? path : () => path;
  return computed<T>({
    get: () => getDeep(synth.project as unknown as Record<string, unknown>, resolve()) as T,
    set: (v) => synth.dispatchLocal(resolve(), v),
  });
}
