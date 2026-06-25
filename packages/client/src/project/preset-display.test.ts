import { describe, it, expect } from 'vitest';
import { groupPresets } from './preset-display.js';
import type { PresetRecord } from '@fiddle/shared';

const rec = (id: string, ownerUserId: string): PresetRecord => ({
  id, name: id, engineType: 'kick2', params: {}, ownerUserId,
  ownerUsername: null, isPublic: true, createdAt: '', updatedAt: '',
});

describe('groupPresets', () => {
  it('splits into yours vs others for a logged-in user', () => {
    const out = groupPresets([rec('a', 'u1'), rec('b', 'u2'), rec('c', 'u1')], 'u1');
    expect(out.yours.map((r) => r.id)).toEqual(['a', 'c']);
    expect(out.others.map((r) => r.id)).toEqual(['b']);
  });

  it('puts everything in others for a guest', () => {
    const out = groupPresets([rec('a', 'u1'), rec('b', 'u2')], null);
    expect(out.yours).toEqual([]);
    expect(out.others.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
