// Parse a raw <input type="number"> string into a valid integer within [min, max].
//
// The per-step OCT/LEN fields edit live, reactive `Step` values that re-render
// ~8×/sec during playback. Binding them directly with `v-model.number` makes
// editing impossible: clearing the field yields an empty string → NaN, which
// `.number` rejects, so the next re-render reverts what you typed. Instead the
// field keeps a string draft and commits through this helper on change/blur.
//
// Empty input (or anything non-finite) commits the `fallback` (the current
// value) so clearing a field is a no-op rather than a stuck NaN.
export function clampStepField(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw.trim() === '') return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
