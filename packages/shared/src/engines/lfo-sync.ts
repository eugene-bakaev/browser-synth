// Single source of truth for LFO tempo-sync note divisions (spec
// 2026-07-05-lfo-tempo-sync-design.md). Consumed by the synth2 descriptor table
// (enum values), AudioEngine (rate derivation), and Synth2Panel (knob labels).
// The index is the wire encoding for the `lfo*.div` enum and is append-stable.

export interface LfoSyncDivision {
  /** Display label, also the persisted enum value (e.g. "1/16", "1/8.", "1/4T"). */
  readonly label: string;
  /** Beats per LFO cycle, quarter-note = 1 beat. Dotted = ×1.5, triplet = ×2/3. */
  readonly beats: number;
}

// Ordered slowest → fastest so the knob sweeps left(slow)→right(fast), matching
// the free-mode Hz knob's direction.
export const LFO_SYNC_DIVISIONS: readonly LfoSyncDivision[] = [
  { label: '1/1.',  beats: 6 },
  { label: '1/1',   beats: 4 },
  { label: '1/2.',  beats: 3 },
  { label: '1/1T',  beats: 8 / 3 },
  { label: '1/2',   beats: 2 },
  { label: '1/4.',  beats: 1.5 },
  { label: '1/2T',  beats: 4 / 3 },
  { label: '1/4',   beats: 1 },
  { label: '1/8.',  beats: 0.75 },
  { label: '1/4T',  beats: 2 / 3 },
  { label: '1/8',   beats: 0.5 },
  { label: '1/16.', beats: 0.375 },
  { label: '1/8T',  beats: 1 / 3 },
  { label: '1/16',  beats: 0.25 },
  { label: '1/32.', beats: 0.1875 },
  { label: '1/16T', beats: 1 / 6 },
  { label: '1/32',  beats: 0.125 },
  { label: '1/32T', beats: 1 / 12 },
];

export const LFO_SYNC_LABELS: readonly string[] = LFO_SYNC_DIVISIONS.map(d => d.label);
export const LFO_SYNC_DEFAULT_LABEL = '1/16';
export const LFO_SYNC_DEFAULT_INDEX = LFO_SYNC_LABELS.indexOf(LFO_SYNC_DEFAULT_LABEL);

/** Note-division label + BPM → LFO frequency in Hz. Unknown label falls back to
 *  the default division, so a corrupt/old value can never yield NaN. */
export function divisionToHz(label: string, bpm: number): number {
  const entry = LFO_SYNC_DIVISIONS.find(d => d.label === label)
    ?? LFO_SYNC_DIVISIONS[LFO_SYNC_DEFAULT_INDEX];
  return bpm / (60 * entry.beats);
}

/** Division label → its index; unknown label → the default index. */
export function divisionLabelToIndex(label: string): number {
  const i = LFO_SYNC_LABELS.indexOf(label);
  return i < 0 ? LFO_SYNC_DEFAULT_INDEX : i;
}
