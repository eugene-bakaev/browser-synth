import { describe, it, expect } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { buildLobbyList } from './lobby.js';
import type { SessionRecord } from './SessionStore.js';

function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'x', name: 'n', description: '', ownerUserId: 'u', ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS, createdAt: new Date(0), updatedAt: new Date(0),
    ...over,
  };
}

describe('buildLobbyList', () => {
  it('lists a logged-in-owned session even with no members', () => {
    const out = buildLobbyList([rec({ id: 'a', ownerUserId: 'u1' })], new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', isGuestOwned: false, memberCount: 0, live: false });
  });

  it('hides a guest-owned session with no members, shows it when occupied', () => {
    const guest = rec({ id: 'g', ownerUserId: null, ownerClientId: 'c1' });
    expect(buildLobbyList([guest], new Map())).toEqual([]);
    const shown = buildLobbyList([guest], new Map([['g', 2]]));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: 'g', isGuestOwned: true, memberCount: 2, live: true });
  });

  it('annotates member counts and preserves input order', () => {
    const out = buildLobbyList(
      [rec({ id: 'a', ownerUserId: 'u1' }), rec({ id: 'b', ownerUserId: 'u2' })],
      new Map([['a', 1]]),
    );
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out[0].memberCount).toBe(1);
    expect(out[1].memberCount).toBe(0);
  });

  it('serialises timestamps to ISO strings', () => {
    const out = buildLobbyList(
      [rec({ id: 'a', ownerUserId: 'u1', updatedAt: new Date('2026-05-31T00:00:00Z') })],
      new Map(),
    );
    expect(out[0].updatedAt).toBe('2026-05-31T00:00:00.000Z');
  });
});
