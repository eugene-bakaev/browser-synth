import { describe, it, expect, vi } from 'vitest';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { withDbSpan, instrumentSessionStore, instrumentProfileStore } from './db.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { ProfileStore } from '../profile/ProfileStore.js';

describe('withDbSpan', () => {
  it('returns the wrapped result (no-op when no OTel provider is set)', async () => {
    const result = await withDbSpan('test.op', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates thrown errors', async () => {
    await expect(
      withDbSpan('test.op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('instrumentSessionStore', () => {
  it('delegates every method to the inner store unchanged', async () => {
    const inner: SessionStore = {
      create: vi.fn(async () => ({}) as never),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      getSnapshot: vi.fn(async () => null),
      saveSnapshot: vi.fn(async () => {}),
      updateMeta: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const store = instrumentSessionStore(inner);

    const createInput = {
      id: 's1',
      name: 'n',
      description: '',
      ownerUserId: null,
      ownerClientId: null,
      settings: DEFAULT_SESSION_SETTINGS,
      project: freshProject(),
    };
    await store.create(createInput);
    const listed = await store.list();
    const got = await store.get('s1');
    await store.getSnapshot('s1');
    await store.saveSnapshot('s1', freshProject());
    await store.updateMeta('s1', { name: 'n' });
    await store.delete('s1');

    expect(inner.create).toHaveBeenCalledWith(createInput);
    expect(inner.list).toHaveBeenCalledTimes(1);
    expect(inner.get).toHaveBeenCalledWith('s1');
    expect(inner.getSnapshot).toHaveBeenCalledWith('s1');
    expect(inner.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(inner.updateMeta).toHaveBeenCalledWith('s1', { name: 'n' });
    expect(inner.delete).toHaveBeenCalledWith('s1');
    // Return values pass through unchanged (transparent decorator).
    expect(listed).toEqual([]);
    expect(got).toBeNull();
  });
});

describe('instrumentProfileStore', () => {
  it('delegates getUsername and returns its value', async () => {
    const inner: ProfileStore = { getUsername: vi.fn(async () => 'neo') };
    const store = instrumentProfileStore(inner);
    expect(await store.getUsername('u1')).toBe('neo');
    expect(inner.getUsername).toHaveBeenCalledWith('u1');
  });
});
