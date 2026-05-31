// Tier B presence palette (8 distinct hues; room capacity is bounded by the
// palette size so each connected client gets a unique color).
export const PALETTE = [
  '#FF4136', '#FF851B', '#FFDC00', '#2ECC40',
  '#39CCCC', '#0074D9', '#B10DC9', '#F012BE',
] as const;
export type PaletteColor = typeof PALETTE[number];

// Short, friendly animal handles. Server picks the first not in use in a room.
// 20 entries — comfortably exceeds the 8-color presence cap and gives the
// handle picker room to suffix-disambiguate if it ever needs to.
export const HANDLES = [
  'Owl', 'Fox', 'Otter', 'Lynx', 'Hawk', 'Mole',
  'Frog', 'Wren', 'Toad', 'Bat',  'Ibis', 'Kit',
  'Stoat','Crane','Raven','Newt', 'Marten','Vole',
  'Jay',  'Heron',
] as const;
// Custom usernames (authenticated users) can be any string; guest handles are
// still drawn from HANDLES below. The type is open so an account-supplied name
// is assignable to Identity.handle.
export type Handle = string;

// Crockford base32 alphabet (no i, l, o, u — disambiguates 1/I/L and 0/O, and
// drops u to avoid accidental words). Shared so the client's room ids and the
// server's client ids draw from the same alphabet (do not reorder).
export const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

// `len` random Crockford-base32 chars. Not cryptographically strong — callers
// that need uniqueness guarantees must re-check against existing ids.
export function randomBase32(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CROCKFORD_BASE32[Math.floor(Math.random() * CROCKFORD_BASE32.length)];
  }
  return out;
}
