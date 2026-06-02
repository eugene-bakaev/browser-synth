import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listSessions, getSession, createSession, patchSession, deleteSession } from './sessionsApi';

function mockFetch(impl: (url: string, init?: RequestInit) => Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const r = impl(url, init);
    return { ok: true, status: 200, json: async () => ({}), ...r } as Response;
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('sessionsApi', () => {
  it('listSessions unwraps { sessions }', async () => {
    mockFetch(() => ({ json: async () => ({ sessions: [{ id: 'a' }, { id: 'b' }] }) }));
    const out = await listSessions();
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('getSession returns null on 404', async () => {
    mockFetch(() => ({ ok: false, status: 404 }));
    expect(await getSession('nope')).toBeNull();
  });

  it('createSession POSTs the body + bearer token and returns the id', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    mockFetch((url, init) => { seen = { url, init }; return { status: 201, json: async () => ({ id: 'new9chars' }) }; });
    const id = await createSession({ name: 'Jam', description: '', seed: 'default' } as any, 'tok-1');
    expect(id).toBe('new9chars');
    expect(seen!.init?.method).toBe('POST');
    expect((seen!.init?.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seen!.init?.body as string)).toMatchObject({ name: 'Jam' });
  });

  it('createSession omits the auth header for guests', async () => {
    let headers: Record<string, string> = {};
    mockFetch((_url, init) => { headers = init?.headers as Record<string, string>; return { status: 201, json: async () => ({ id: 'x' }) }; });
    await createSession({ name: 'g', description: '', seed: 'default', clientId: 'g_1' } as any);
    expect(headers.authorization).toBeUndefined();
  });

  it('patchSession sends PATCH and resolves on 204', async () => {
    let method = '';
    mockFetch((_url, init) => { method = init?.method ?? ''; return { ok: true, status: 204 }; });
    await patchSession('a', { name: 'renamed' }, 'tok');
    expect(method).toBe('PATCH');
  });

  it('deleteSession sends DELETE', async () => {
    let method = '';
    mockFetch((_url, init) => { method = init?.method ?? ''; return { ok: true, status: 204 }; });
    await deleteSession('a', 'tok');
    expect(method).toBe('DELETE');
  });

  it('throws on a non-ok create', async () => {
    mockFetch(() => ({ ok: false, status: 400, json: async () => ({ error: 'bad' }) }));
    await expect(createSession({ name: '', description: '', seed: 'default' } as any)).rejects.toThrow();
  });
});
