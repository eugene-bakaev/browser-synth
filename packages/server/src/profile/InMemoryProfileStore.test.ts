import { describe, it, expect } from 'vitest';
import { InMemoryProfileStore } from './InMemoryProfileStore.js';

describe('InMemoryProfileStore', () => {
  it('returns null for an unknown user', async () => {
    const store = new InMemoryProfileStore();
    expect(await store.getUsername('nobody')).toBeNull();
  });

  it('returns a seeded username', async () => {
    const store = new InMemoryProfileStore({ 'user-1': 'DJ Eugene' });
    expect(await store.getUsername('user-1')).toBe('DJ Eugene');
  });

  it('set() then get() round-trips', async () => {
    const store = new InMemoryProfileStore();
    store.set('user-2', 'Beatmaker');
    expect(await store.getUsername('user-2')).toBe('Beatmaker');
  });
});
