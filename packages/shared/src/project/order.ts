// Track display-order helpers. `trackOrder` is a permutation of pool indices
// (0..TRACK_POOL_SIZE-1): position in the array = display position, value =
// pool index. The tracks pool itself NEVER moves — track identity is the pool
// index everywhere (sync paths, engines, selection); only presentation order
// changes. See docs/superpowers/specs/2026-07-15-track-reorder-design.md.

import { TRACK_POOL_SIZE } from './constants.js';

export function identityTrackOrder(): number[] {
  return Array.from({ length: TRACK_POOL_SIZE }, (_, i) => i);
}

export function isValidTrackOrder(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === TRACK_POOL_SIZE &&
    v.every((n) => Number.isInteger(n) && n >= 0 && n < TRACK_POOL_SIZE) &&
    new Set(v).size === TRACK_POOL_SIZE
  );
}

// Repair-path dual of coerceBpm: a valid order rides through by reference,
// anything else heals to identity. Shared by normalizeProject (sync/server
// boundary) and reconcileWithDefaults (client offline boundary).
export function coerceTrackOrder(v: unknown): number[] {
  return isValidTrackOrder(v) ? v : identityTrackOrder();
}

export function ordersEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Move `moved` so it sits immediately before `anchor` (null = end of the
// order). Anchoring on a pool index (not a display position) keeps the math
// independent of which slots are enabled: disabled slots keep their relative
// positions. Always returns a fresh array; callers skip dispatch when
// ordersEqual(next, current).
export function moveTrackBefore(
  order: readonly number[],
  moved: number,
  anchor: number | null,
): number[] {
  if (moved === anchor) return [...order];
  const rest = order.filter((p) => p !== moved);
  const at = anchor === null ? rest.length : rest.indexOf(anchor);
  rest.splice(at === -1 ? rest.length : at, 0, moved);
  return rest;
}
