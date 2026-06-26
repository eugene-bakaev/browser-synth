// Room IDs are short, URL-safe identifiers used both as the routing token
// (`/r/<roomId>`) and as the key under which the server stores room state.
//
// Plan 3: rooms are created only via the lobby (POST /api/sessions returns the
// id), so the client no longer mints ids from the URL. These helpers are pure
// URL plumbing: read the current room, set it when entering a session, clear it
// when leaving.

const ROOM_RE = /^\/r\/([0-9a-z]{6,12})/i;

// The room id in the current URL (`/r/<id>`), or null if none. Case-insensitive,
// normalized to lowercase (the server keys rooms by exact string). `loc` is
// injectable for testing without touching jsdom's history mock.
export function readRoomIdFromUrl(loc: Location = window.location): string | null {
  const m = loc.pathname.match(ROOM_RE);
  return m ? m[1].toLowerCase() : null;
}

// Which in-app view a fresh load lands on, derived from the URL: a `/r/<id>`
// deep-link opens the studio; anything else opens the lobby.
export function resolveInitialView(loc: Location = window.location): 'studio' | 'lobby' {
  return readRoomIdFromUrl(loc) ? 'studio' : 'lobby';
}

// Rewrite the address bar to `/r/<id>` without a real navigation (memory-history
// router handles view switching; the URL is just the shareable session token).
// Default 'replace' keeps a single entry (deep-link boot, reconciling the URL we
// already sit on). 'push' adds a history entry, used when the user enters a
// session from the lobby so the browser Back button returns to the lobby instead
// of stepping out of the app entirely.
export function setRoomInUrl(roomId: string, mode: 'push' | 'replace' = 'replace'): void {
  const url = `/r/${roomId}`;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

// Drop the room from the address bar when returning to the lobby.
export function clearRoomFromUrl(): void {
  window.history.replaceState(null, '', '/');
}
