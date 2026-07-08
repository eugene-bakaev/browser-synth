// Single source of truth for envelope tempo-sync STEP divisions (spec
// 2026-07-08-env-step-divisions-design.md). Envelope A/D/R stage lengths are
// measured in sequencer steps (one step = a 1/16 note = (60/bpm)/4 seconds),
// unlike the LFO's note divisions (lfo-sync.ts) — the two vocabularies are
// deliberately separate. Consumed by the synth2 descriptor table (enum
// values), AudioEngine (seconds derivation), and Synth2Panel (knob labels).

export interface EnvSyncDivision {
  /** Display label, also the persisted enum value (e.g. "1/2", "1.5", "16"). */
  readonly label: string;
  /** Length in sequencer steps; one step = a 1/16 note = (60/bpm)/4 seconds. */
  readonly steps: number;
}

// Ordered slowest → fastest so the knob sweeps left(slow)→right(fast),
// matching the free-mode seconds knob and the LFO sync knob.
export const ENV_SYNC_DIVISIONS: readonly EnvSyncDivision[] = [
  { label: '32',   steps: 32 },
  { label: '24',   steps: 24 },
  { label: '16',   steps: 16 },
  { label: '12',   steps: 12 },
  { label: '8',    steps: 8 },
  { label: '6',    steps: 6 },
  { label: '4',    steps: 4 },
  { label: '3',    steps: 3 },
  { label: '2',    steps: 2 },
  { label: '1.5',  steps: 1.5 },
  { label: '1',    steps: 1 },
  { label: '3/4',  steps: 3 / 4 },
  { label: '2/3',  steps: 2 / 3 },
  { label: '1/2',  steps: 1 / 2 },
  { label: '1/3',  steps: 1 / 3 },
  { label: '1/4',  steps: 1 / 4 },
  { label: '1/6',  steps: 1 / 6 },
  { label: '1/8',  steps: 1 / 8 },
  { label: '1/16', steps: 1 / 16 },
];

export const ENV_SYNC_LABELS: readonly string[] = ENV_SYNC_DIVISIONS.map(d => d.label);
export const ENV_SYNC_DEFAULT_LABEL = '1';
export const ENV_SYNC_DEFAULT_INDEX = ENV_SYNC_LABELS.indexOf(ENV_SYNC_DEFAULT_LABEL);

/** Step-division label + BPM → duration in seconds (steps × one step's length,
 *  (60/bpm)/4). Unknown label falls back to the default division, so a
 *  corrupt/legacy note-division value can never yield NaN. */
export function envDivisionToSeconds(label: string, bpm: number): number {
  const entry = ENV_SYNC_DIVISIONS.find(d => d.label === label)
    ?? ENV_SYNC_DIVISIONS[ENV_SYNC_DEFAULT_INDEX];
  return (entry.steps * 15) / bpm;
}

/** Division label → its index; unknown label → the default index. */
export function envDivisionLabelToIndex(label: string): number {
  const i = ENV_SYNC_LABELS.indexOf(label);
  return i < 0 ? ENV_SYNC_DEFAULT_INDEX : i;
}
