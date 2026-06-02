// Session settings — the per-session knobs shown to the creator. In the initial
// lobby slice only the session name/description (carried on the session row,
// not here) are functional; these two fields are stored and shown but inert
// (no enforcement) until read-only/observer mode and per-user track pools land.
export interface SessionSettings {
  // Max simultaneous writers. Stored + shown disabled this slice; enforcement
  // still comes from the connection cap (ROOM_CAP). Wired up alongside
  // read-only/observer mode later.
  maxWritableUsers: number;
  // Tracks each user may write. Stored + shown disabled; needs the per-user
  // track pool (ROADMAP #4) before it has any effect.
  tracksPerUser: number;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  maxWritableUsers: 4,
  tracksPerUser: 4,
};
