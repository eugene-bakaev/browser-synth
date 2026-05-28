// Pure helpers for assigning a connecting client a unique color + handle and
// minting a stable clientId. No I/O, no state — the caller passes in the
// current roster so this module stays trivially testable.

import { PALETTE, HANDLES } from '@fiddle/shared';
import type { Identity, PaletteColor, Handle } from '@fiddle/shared';

// Crockford base32 alphabet (no i, l, o, u — disambiguates 1/I/L and 0/O,
// and drops u to avoid accidental words). Copy this string verbatim from the
// plan; do not reorder.
const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * First PALETTE entry not present in `taken`. Room capacity is bounded by the
 * palette size (4 ≤ 8) so the "all taken" branch is unreachable in practice;
 * we still pick a random color to keep the function total.
 */
export function assignColor(taken: ReadonlySet<string>): PaletteColor {
  for (const color of PALETTE) {
    if (!taken.has(color)) return color;
  }
  return PALETTE[Math.floor(Math.random() * PALETTE.length)]!;
}

/**
 * First HANDLES entry not present in `taken`. If all 20 are taken (which
 * exceeds the room cap), append an ascending digit suffix (`Owl2`, `Owl3`, …).
 * An absurdity guard returns a timestamped fallback so the function is total.
 */
export function assignHandle(taken: ReadonlySet<string>): Handle | string {
  for (const handle of HANDLES) {
    if (!taken.has(handle)) return handle;
  }
  // All base handles are taken — try `<handle>2`, `<handle>3`, … up to a sane
  // bound. With a 4-client cap this branch is itself unreachable; the guard
  // exists to keep the function total.
  for (let suffix = 2; suffix < 1000; suffix++) {
    for (const handle of HANDLES) {
      const candidate = `${handle}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  return `User_${Date.now()}`;
}

/**
 * `c_` prefix + 7 Crockford base32 chars. ~32^7 ≈ 3.4e10 — collision risk is
 * negligible at the scale of a single-process server, but callers that need
 * stronger guarantees should re-check via `RoomStore.getIdentity`.
 */
export function generateClientId(): string {
  let out = 'c_';
  for (let i = 0; i < 7; i++) {
    out += CROCKFORD_BASE32[Math.floor(Math.random() * CROCKFORD_BASE32.length)];
  }
  return out;
}

/**
 * Compose a fresh Identity from the current roster. The `as Handle` coercion
 * is acceptable: the suffix-fallback branch produces a `string` rather than a
 * literal HANDLES entry, but Identity.handle is the contract the server
 * promises and the absurdity guard is unreachable in practice.
 */
export function makeIdentity(existing: readonly Identity[]): Identity {
  const takenColors = new Set<string>(existing.map((i) => i.color));
  const takenHandles = new Set<string>(existing.map((i) => i.handle));
  return {
    clientId: generateClientId(),
    color: assignColor(takenColors),
    handle: assignHandle(takenHandles) as Handle,
  };
}
