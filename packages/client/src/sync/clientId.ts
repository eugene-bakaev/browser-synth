// A stable per-browser guest identity, persisted in localStorage. Sent as the
// `clientId` when a guest creates a session (POST /api/sessions) and matched
// when a guest edits its own session's settings (PATCH). Distinct from the
// per-room WS clientId (minted server-side, lives in sessionStorage).
import { randomBase32 } from '@fiddle/shared';

const KEY = 'fiddle:clientId';

export function guestClientId(): string {
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  const fresh = `g_${randomBase32(12)}`;
  localStorage.setItem(KEY, fresh);
  return fresh;
}
