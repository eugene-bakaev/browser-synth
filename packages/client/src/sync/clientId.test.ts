import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('guestClientId', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    vi.resetModules();
  });

  it('mints once and is stable across calls', async () => {
    const { guestClientId } = await import('./clientId');
    const a = guestClientId();
    const b = guestClientId();
    expect(a).toBe(b);
    expect(a).toMatch(/^g_[0-9a-z]+$/);
  });

  it('reuses a previously persisted id', async () => {
    store.set('fiddle:clientId', 'g_existing');
    const { guestClientId } = await import('./clientId');
    expect(guestClientId()).toBe('g_existing');
  });
});
