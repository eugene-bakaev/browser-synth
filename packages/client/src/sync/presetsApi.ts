// Typed HTTP client for /api/presets. Same-origin in dev via the Vite /api
// proxy; cross-origin in prod via VITE_API_URL. Mirrors sessionsApi.ts.
import type { PresetRecord, CreatePresetBody, PatchPresetBody, EngineType } from '@fiddle/shared';

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

export async function listPresets(engineType?: EngineType, token?: string): Promise<PresetRecord[]> {
  const qs = engineType ? `?engineType=${encodeURIComponent(engineType)}` : '';
  const res = await fetch(apiUrl(`/api/presets${qs}`), { headers: headers(token) });
  if (!res.ok) throw new Error(`list presets failed: ${res.status}`);
  const body = (await res.json()) as { presets: PresetRecord[] };
  return body.presets;
}

export async function createPreset(body: CreatePresetBody, token: string): Promise<string> {
  const res = await fetch(apiUrl('/api/presets'), {
    method: 'POST', headers: headers(token, true), body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create preset failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

export async function patchPreset(id: string, patch: PatchPresetBody, token: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/presets/${id}`), {
    method: 'PATCH', headers: headers(token, true), body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch preset failed: ${res.status}`);
}

export async function deletePreset(id: string, token: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/presets/${id}`), { method: 'DELETE', headers: headers(token) });
  if (!res.ok) throw new Error(`delete preset failed: ${res.status}`);
}
