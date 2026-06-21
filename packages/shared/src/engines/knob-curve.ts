// UI knob response curve (presentational only — see
// docs/superpowers/specs/2026-06-21-knob-tapers-design.md §3). Declared per-param
// on the descriptor tables; consumed by the client knob taper. Adding/omitting a
// curve never changes a stored/synced value, so this is NOT an ABI concern.
export type KnobCurve = 'linear' | 'exp' | 'invexp' | 's';
