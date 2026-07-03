// Pure param-diff helpers, shared by AudioEngine (its slice watcher) and the
// bulk project ops (app/projectOps draft-diff-dispatch). Lives in its own leaf
// module because both units need it — putting it in either would create an
// import cycle. Relocated verbatim from useSynth.ts (Phases 4–5).

// Returns the subset of `newVal` keys whose values differ from `oldVal`, or
// null if nothing changed. Used to feed engine.applyParams() the minimum set
// of writes per knob turn instead of the full slice (was 13 writes/knob for
// the synth; now typically 1).
export function diffParams<T extends Record<string, unknown>>(
  newVal: T,
  oldVal: T | undefined
): Partial<T> | null {
  if (!oldVal) return null;
  const changed: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(newVal) as Array<keyof T>) {
    const a = newVal[key];
    const b = oldVal[key];
    if (a === b) continue;
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    }
    changed[key] = a as T[keyof T];
    any = true;
  }
  return any ? changed : null;
}

// Deep-ish clone of an engine slice: copies one level of nested param objects
// (synth2's osc1/env1/filter…) and array-of-object slots (the matrix) so the
// result is a stable "before" image that an in-place nested mutation on the live
// slice cannot leak into. Used by both the bulk project snapshot and preset-load
// diffing (applyPresetSynced), which otherwise depend on the caller replacing
// nested references rather than mutating them.
export function cloneEngineSlice(src: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (Array.isArray(v)) copy[k] = v.map((el) => (el && typeof el === 'object' ? { ...el } : el));
    else if (v && typeof v === 'object') copy[k] = { ...(v as Record<string, unknown>) };
    else copy[k] = v;
  }
  return copy;
}
