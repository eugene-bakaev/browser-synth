import { describe, it, expect } from 'vitest';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { InMemorySessionStore } from './InMemorySessionStore.js';
import type { CreateSessionInput } from './SessionStore.js';

function input(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id: 'sess-1',
    name: 'My Jam',
    description: 'a groove',
    ownerUserId: 'user-1',
    ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS,
    project: freshProject(),
    ...overrides,
  };
}

describe('InMemorySessionStore', () => {
  it('create then get returns the metadata record', async () => {
    const store = new InMemorySessionStore();
    const created = await store.create(input());
    expect(created.id).toBe('sess-1');
    expect(created.name).toBe('My Jam');
    expect(created.ownerUserId).toBe('user-1');
    const got = await store.get('sess-1');
    expect(got?.name).toBe('My Jam');
    expect(got?.description).toBe('a groove');
  });

  it('get returns null for a missing session', async () => {
    const store = new InMemorySessionStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('stores the initial snapshot and serves it back', async () => {
    const store = new InMemorySessionStore();
    await store.create(input());
    const snap = await store.getSnapshot('sess-1');
    expect(snap?.tracks).toHaveLength(4);
  });

  it('saveSnapshot overwrites the current snapshot', async () => {
    const store = new InMemorySessionStore();
    await store.create(input());
    const edited = freshProject();
    edited.bpm = 145;
    await store.saveSnapshot('sess-1', edited);
    expect((await store.getSnapshot('sess-1'))?.bpm).toBe(145);
  });

  it('saveSnapshot on a missing session is a no-op (no throw)', async () => {
    const store = new InMemorySessionStore();
    await store.saveSnapshot('ghost', freshProject());
    expect(await store.getSnapshot('ghost')).toBeNull();
  });

  it('list returns sessions most-recently-updated first', async () => {
    const store = new InMemorySessionStore();
    await store.create(input({ id: 'a' }));
    await store.create(input({ id: 'b' }));
    // Touch 'a' so it becomes the most recently updated.
    await store.updateMeta('a', { name: 'renamed' });
    const ids = (await store.list()).map((r) => r.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('updateMeta patches only provided fields and bumps updatedAt', async () => {
    const store = new InMemorySessionStore();
    const created = await store.create(input());
    await store.updateMeta('sess-1', { description: 'new desc' });
    const got = await store.get('sess-1');
    expect(got?.name).toBe('My Jam');        // unchanged
    expect(got?.description).toBe('new desc'); // changed
    expect(got!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('updateMeta on a missing session is a no-op', async () => {
    const store = new InMemorySessionStore();
    await store.updateMeta('ghost', { name: 'x' });
    expect(await store.get('ghost')).toBeNull();
  });

  it('delete removes both the record and its snapshot', async () => {
    const store = new InMemorySessionStore();
    await store.create(input());
    await store.delete('sess-1');
    expect(await store.get('sess-1')).toBeNull();
    expect(await store.getSnapshot('sess-1')).toBeNull();
  });
});
