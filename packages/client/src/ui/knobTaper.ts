import type { KnobCurve } from '@fiddle/shared';

// A curve is a warp w(p): [0,1] → [0,1] applied to the dial travel p, then mapped
// linearly to [min,max]:  value = min + (max-min)·w(p).  See
// docs/superpowers/specs/2026-06-21-knob-tapers-design.md §3.
//
// exp/invexp involve a log and are valid only on a strictly-positive range
// (min>0, max>min). For any other range — or non-finite input — every function
// falls back to linear / clamps, so a knob can never emit NaN.

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Whether exp/invexp are mathematically valid for this range. */
function expUsable(min: number, max: number): boolean {
  return Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min && Number.isFinite(max / min);
}

/** Forward warp w(p): [0,1] → [0,1]. */
function warp(curve: KnobCurve, p: number, min: number, max: number): number {
  // Guard non-finite pos up front (clamp01 would otherwise pass NaN through).
  if (!Number.isFinite(p)) return 0;
  const t = clamp01(p);
  switch (curve) {
    case 'exp': {
      if (!expUsable(min, max)) return t;
      const r = max / min;
      return (Math.pow(r, t) - 1) / (r - 1);
    }
    case 'invexp': {
      if (!expUsable(min, max)) return t;
      const r = max / min;
      return 1 - (Math.pow(r, 1 - t) - 1) / (r - 1);
    }
    case 's':
      return t * t * (3 - 2 * t); // smoothstep
    case 'linear':
    default:
      return t;
  }
}

/** Inverse warp w⁻¹(u): [0,1] → [0,1]. */
function unwarp(curve: KnobCurve, u: number, min: number, max: number): number {
  const v = clamp01(u);
  switch (curve) {
    case 'exp': {
      if (!expUsable(min, max)) return v;
      const r = max / min;
      return Math.log(v * (r - 1) + 1) / Math.log(r);
    }
    case 'invexp': {
      if (!expUsable(min, max)) return v;
      const r = max / min;
      return 1 - Math.log((1 - v) * (r - 1) + 1) / Math.log(r);
    }
    case 's':
      // Closed-form inverse of smoothstep u = 3t²−2t³.
      return 0.5 - Math.sin(Math.asin(1 - 2 * v) / 3);
    case 'linear':
    default:
      return v;
  }
}

/** Dial travel pos∈[0,1] → parameter value, clamped to [min,max]. */
export function posToValue(curve: KnobCurve, pos: number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max === min) return min;
  const value = min + (max - min) * warp(curve, pos, min, max);
  return value < min ? min : value > max ? max : value;
}

/** Parameter value → dial travel pos∈[0,1]. Out-of-range/non-finite values clamp. */
export function valueToPos(curve: KnobCurve, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return 0;
  }
  const u = (value - min) / (max - min);
  return clamp01(unwarp(curve, u, min, max));
}
