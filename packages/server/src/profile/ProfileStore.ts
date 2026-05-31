// ProfileStore — read surface for per-user profile data the realtime server
// needs (just the username today). Async so the Postgres implementation can
// drop in without touching ConnectionHandler. Mirrors the RoomStore pattern.

export interface ProfileStore {
  // The user's chosen username, or null if unset / unknown. The server falls
  // back to the Google display name from the JWT when this is null.
  getUsername(userId: string): Promise<string | null>;
}
