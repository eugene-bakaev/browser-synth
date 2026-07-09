// Constants used in project schema and factories.

// Fixed pool of track slots. The array is always this long on the wire and in
// memory; "add/remove track" toggles a slot's `enabled` flag (no structural
// sync op, no index shift). Sized for the eventual per-user vision (up to 4
// users x up to 8 tracks) so the storage shape is migrated exactly once.
export const TRACK_POOL_SIZE = 32;

// A fresh/new project starts with this many enabled slots (the four tracks
// users see today). The rest of the pool is present but disabled.
export const DEFAULT_ENABLED_TRACKS = 4;

// Every track's `steps` is always a fixed buffer of this many elements, on the
// wire and in memory; `patternLength` (1..STEP_BUFFER_SIZE) is the play/render
// window within it. Single source for the factory, the boundary repair
// (normalizeProject), and the client's reconcile/replace paths.
export const STEP_BUFFER_SIZE = 64;

// patternLength default for a fresh track (and the repair fallback).
export const DEFAULT_PATTERN_LENGTH = 16;

// Transport tempo. Single source of truth for the bpm range + default: the
// prototype (freshProject), the wire schema (ProjectSchema), and the boundary
// repair (coerceBpm / reconcileWithDefaults) all derive from these so the
// range can never drift between them. No engine-level clamp — the sequencer
// schedules off bpm directly, so it stays an integer in a generous-but-sane band.
export const DEFAULT_BPM = 120;
export const BPM_MIN = 40;
export const BPM_MAX = 240;

// Custom track name length cap (chars). '' = unnamed — every label site
// falls back to the live default `Track ${index + 1}` (trackDisplayName).
export const TRACK_NAME_MAX_LENGTH = 24;
