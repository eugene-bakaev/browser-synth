// Constants used in project schema and factories.

// Fixed pool of track slots. The array is always this long on the wire and in
// memory; "add/remove track" toggles a slot's `enabled` flag (no structural
// sync op, no index shift). Sized for the eventual per-user vision (up to 4
// users x up to 8 tracks) so the storage shape is migrated exactly once.
export const TRACK_POOL_SIZE = 32;

// A fresh/new project starts with this many enabled slots (the four tracks
// users see today). The rest of the pool is present but disabled.
export const DEFAULT_ENABLED_TRACKS = 4;
