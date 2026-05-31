import type { LobbyEntry } from '@fiddle/shared';
import type { SessionRecord } from './SessionStore.js';

// Merge durable session metadata with live presence into the lobby list.
//   - logged-in-owned sessions: always listed.
//   - guest-owned sessions (ownerUserId === null): listed only while occupied
//     (memberCount > 0), so an abandoned guest room disappears immediately —
//     even before its row is pruned by SessionSync.
// Input order is preserved (the store returns most-recently-updated first); this
// function only filters + annotates.
export function buildLobbyList(
  records: SessionRecord[],
  liveCounts: Map<string, number>,
): LobbyEntry[] {
  const entries: LobbyEntry[] = [];
  for (const r of records) {
    const memberCount = liveCounts.get(r.id) ?? 0;
    const isGuestOwned = r.ownerUserId === null;
    if (isGuestOwned && memberCount === 0) continue; // hide abandoned guest rooms
    entries.push({
      id: r.id,
      name: r.name,
      description: r.description,
      ownerUserId: r.ownerUserId,
      isGuestOwned,
      memberCount,
      live: memberCount > 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  return entries;
}
