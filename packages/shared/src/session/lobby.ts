// The lobby list entry — the wire shape GET /api/sessions returns and the lobby
// UI (Plan 3) renders. The server builds it by merging durable session metadata
// with live in-memory presence. Guest-owned sessions appear only while occupied;
// logged-in-owned sessions always appear.
export interface LobbyEntry {
  id: string;
  name: string;
  description: string;
  // null for guest-owned sessions; the owner's user id otherwise. Username/handle
  // resolution is layered on in the client lobby (Plan 3).
  ownerUserId: string | null;
  isGuestOwned: boolean;
  // Currently-connected member count (0 when no one is in the room).
  memberCount: number;
  // memberCount > 0.
  live: boolean;
  // ISO-8601 timestamps.
  createdAt: string;
  updatedAt: string;
}
