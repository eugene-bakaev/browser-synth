// Typed HTTP client for the /api/sessions API (Plan 2). Same-origin in dev via
// the Vite /api proxy; cross-origin in prod via VITE_API_URL (client on Vercel,
// server on Render). Request shapes reuse the shared zod-inferred types so the
// client and server validate against one contract.
import type { LobbyEntry, CreateSessionBody, PatchSessionBody, SessionSettings } from '@fiddle/shared';

const API_BASE = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? ''
).replace(/\/$/, '');

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function headers(token?: string, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// The single-record shape from GET /api/sessions/:id (metadata + owner fields).
export interface SessionMeta {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  ownerClientId: string | null;
  isGuestOwned: boolean;
  settings: SessionSettings;
  createdAt: string;
  updatedAt: string;
}

export async function listSessions(): Promise<LobbyEntry[]> {
  const res = await fetch(apiUrl('/api/sessions'));
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  const body = (await res.json()) as { sessions: LobbyEntry[] };
  return body.sessions;
}

export async function getSession(id: string): Promise<SessionMeta | null> {
  const res = await fetch(apiUrl(`/api/sessions/${id}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get session failed: ${res.status}`);
  return (await res.json()) as SessionMeta;
}

export async function createSession(body: CreateSessionBody, token?: string): Promise<string> {
  const res = await fetch(apiUrl('/api/sessions'), {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`create session failed: ${res.status}`);
  }
  const { id } = (await res.json()) as { id: string };
  return id;
}

export async function patchSession(id: string, patch: PatchSessionBody, token?: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/sessions/${id}`), {
    method: 'PATCH',
    headers: headers(token, true),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch session failed: ${res.status}`);
}

export async function deleteSession(id: string, token?: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/sessions/${id}`), {
    method: 'DELETE',
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`delete session failed: ${res.status}`);
}
