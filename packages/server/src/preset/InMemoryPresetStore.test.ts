import { describe, it, expect } from 'vitest';
import { InMemoryPresetStore } from './InMemoryPresetStore.js';
import type { CreatePresetInput } from './PresetStore.js';

function mk(over: Partial<CreatePresetInput> = {}): CreatePresetInput {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'P', engineType: 'kick2', params: { tune: 1 },
    ownerUserId: 'user-1', isPublic: false, ...over,
  };
}

describe('InMemoryPresetStore', () => {
  it('creates and reads back a record', async () => {
    const s = new InMemoryPresetStore();
    const rec = await s.create(mk({ id: 'p1', name: 'Boom' }));
    expect(rec.name).toBe('Boom');
    expect((await s.get('p1'))?.ownerUserId).toBe('user-1');
  });

  it('list scopes to the viewer own + public', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'mine-priv', ownerUserId: 'user-1', isPublic: false }));
    await s.create(mk({ id: 'mine-pub',  ownerUserId: 'user-1', isPublic: true }));
    await s.create(mk({ id: 'other-priv', ownerUserId: 'user-2', isPublic: false }));
    await s.create(mk({ id: 'other-pub',  ownerUserId: 'user-2', isPublic: true }));

    const asUser1 = await s.list({ viewerUserId: 'user-1' });
    expect(asUser1.map((r) => r.id).sort()).toEqual(['mine-priv', 'mine-pub', 'other-pub']);

    const asGuest = await s.list({ viewerUserId: null });
    expect(asGuest.map((r) => r.id).sort()).toEqual(['mine-pub', 'other-pub']);
  });

  it('list filters by engineType', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'k', engineType: 'kick2', isPublic: true }));
    await s.create(mk({ id: 'h', engineType: 'hat2', isPublic: true }));
    const onlyKick = await s.list({ viewerUserId: null, engineType: 'kick2' });
    expect(onlyKick.map((r) => r.id)).toEqual(['k']);
  });

  it('updateMeta patches only provided fields and bumps updatedAt', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'p1', name: 'Old', isPublic: false }));
    await s.updateMeta('p1', { name: 'New' });
    const rec = await s.get('p1');
    expect(rec?.name).toBe('New');
    expect(rec?.isPublic).toBe(false);
  });

  it('delete removes the record', async () => {
    const s = new InMemoryPresetStore();
    await s.create(mk({ id: 'p1' }));
    await s.delete('p1');
    expect(await s.get('p1')).toBeNull();
  });
});
