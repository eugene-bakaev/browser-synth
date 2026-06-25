import { describe, it, expect, vi, afterEach } from 'vitest';
import { listPresets, createPreset, patchPreset, deletePreset } from './presetsApi.js';

function mockFetch(impl: (url: string, init?: RequestInit) => Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => impl(url, init)));
}
afterEach(() => vi.unstubAllGlobals());

describe('presetsApi', () => {
  it('listPresets passes engineType as a query param and unwraps presets', async () => {
    let seenUrl = '';
    mockFetch((url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ presets: [{ id: 'p1' }] }) }; });
    const out = await listPresets('kick2');
    expect(seenUrl).toContain('/api/presets?engineType=kick2');
    expect(out).toEqual([{ id: 'p1' }]);
  });

  it('listPresets without engineType omits the query', async () => {
    let seenUrl = '';
    mockFetch((url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ presets: [] }) }; });
    await listPresets();
    expect(seenUrl).toMatch(/\/api\/presets$/);
  });

  it('createPreset POSTs with bearer auth and returns the id', async () => {
    let seenInit: RequestInit | undefined;
    mockFetch((_url, init) => { seenInit = init; return { ok: true, status: 201, json: async () => ({ id: 'new-id' }) }; });
    const id = await createPreset({ name: 'x', engineType: 'kick2', params: {}, isPublic: false } as never, 'tok');
    expect(id).toBe('new-id');
    expect((seenInit?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(seenInit?.method).toBe('POST');
  });

  it('createPreset throws on non-201', async () => {
    mockFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
    await expect(createPreset({} as never, 'tok')).rejects.toThrow();
  });

  it('patchPreset PATCHes and deletePreset DELETEs', async () => {
    const methods: string[] = [];
    mockFetch((_url, init) => { methods.push(init?.method ?? 'GET'); return { ok: true, status: 204, json: async () => ({}) }; });
    await patchPreset('p', { isPublic: true }, 'tok');
    await deletePreset('p', 'tok');
    expect(methods).toEqual(['PATCH', 'DELETE']);
  });
});
