// useCommandModel — a v-model adapter that routes a control's writes through
// the command bus instead of mutating `project` directly.
//
// The returned writable computed reads the live value at `path` from the
// canonical project (reactively, so the control stays in sync with remote
// edits) and, on write, dispatches a local `set` command via dispatchLocal.
// `path` may be a thunk so a loop-bound control (a step cell, a mixer channel)
// can compute its path per render.

import { computed, type WritableComputedRef } from 'vue';
import { getDeep, type Path } from '@fiddle/shared';
import { project } from '../stores/project';
import { dispatchLocal } from '../composables/useSynth';

export function useCommandModel<T = unknown>(
  path: Path | (() => Path),
): WritableComputedRef<T> {
  const resolve = typeof path === 'function' ? path : () => path;
  return computed<T>({
    get: () => getDeep(project as unknown as Record<string, unknown>, resolve()) as T,
    set: (v) => dispatchLocal(resolve(), v),
  });
}
