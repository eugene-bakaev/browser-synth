// Room IDs are short, URL-safe identifiers used both as the routing token
// (`/r/<roomId>`) and as the key under which the server stores room state.
//
// We use Crockford Base32 (no I/L/O/U to avoid ambiguity) at length 9 — that
// gives us roughly 35 bits of entropy, which is plenty for "stop the player
// from typing a room into the URL and colliding with someone else's room"
// without making the URL too long to share verbally.

const CHARS = '0123456789abcdefghjkmnpqrstvwxyz'; // crockford base32
const ROOM_ID_LEN = 9;

export function generateRoomId(): string {
  let s = '';
  for (let i = 0; i < ROOM_ID_LEN; i++) {
    s += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return s;
}

// Reads the room id from the current URL (`/r/<id>`), or — if the URL has no
// room — mints a fresh one and rewrites the URL via `history.replaceState`.
//
// `loc` is injectable for testing the parsing branch without touching
// jsdom's history mock (which is finicky around replaceState).
export function resolveRoomIdFromUrl(loc: Location = window.location): string {
  const m = loc.pathname.match(/^\/r\/([0-9a-z]{6,12})/i);
  if (m) return m[1];
  const fresh = generateRoomId();
  window.history.replaceState(null, '', `/r/${fresh}`);
  return fresh;
}
