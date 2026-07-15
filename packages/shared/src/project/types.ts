import type {
  SynthEngineParams,
  KickEngineParams,
  HatEngineParams,
  SnareEngineParams,
  ClapEngineParams,
  Synth2EngineParams,
  Kick2EngineParams,
  Snare2EngineParams,
  Hat2EngineParams,
  Clap2EngineParams,
} from '../engines/index.js';
import type { EngineType, MixerState } from '../index.js';

// A single 16th-note slot in a track's pattern. `note` null = rest. `chordType`
// is only meaningful when `isChord` is true but is kept on every step so the
// shape stays stable across the wire.
export interface Step {
  note: string | null;
  octave: number;
  length: number;         // duration in ticks (16th notes)
  velocity: number;       // 0..1
  muted: boolean;
  isChord?: boolean;
  chordType?: string;
}

export interface EngineParamsMap {
  synth: SynthEngineParams;
  kick: KickEngineParams;
  hat: HatEngineParams;
  snare: SnareEngineParams;
  clap: ClapEngineParams;
  synth2: Synth2EngineParams;
  kick2: Kick2EngineParams;
  snare2: Snare2EngineParams;
  hat2: Hat2EngineParams;
  clap2: Clap2EngineParams;
}

export interface ProjectTrack {
  engineType: EngineType;
  // Custom track name. '' = unnamed — the UI falls back to the live default
  // `Track ${index + 1}` (see trackDisplayName in display.ts). Max length is
  // TRACK_NAME_MAX_LENGTH, enforced by TrackSchema on the wire.
  name: string;
  engines: EngineParamsMap;
  mixer: MixerState;
  // `steps` is always a fixed 64-element buffer. `patternLength` (1..64) is the
  // play/render window; steps at indices >= patternLength keep their data but
  // do not play or render. Shrinking the window is therefore non-destructive.
  patternLength: number;
  steps: Step[];
  // Whether this slot is an active track. The slot always exists (the pool is a
  // fixed-length array); disabling is non-destructive — steps/params are kept.
  enabled: boolean;
}

export interface Project {
  schemaVersion: 2;
  bpm: number;
  // Display order: a permutation of pool indices (0..TRACK_POOL_SIZE-1).
  // Position = display position, value = pool index. Presentation ONLY — the
  // tracks pool never moves and every sync path keeps addressing pool indices.
  // Healed to identity by normalizeProject; optional on the wire (old
  // payloads), required here (post-normalize invariant).
  trackOrder: number[];
  // Fixed-length pool (TRACK_POOL_SIZE) — see factory.ts. The length invariant
  // is enforced by ProjectSchema and normalizeProject, not the TS type (a
  // 32-element tuple type is not worth writing).
  tracks: ProjectTrack[];
}

export function activeParams<T extends EngineType>(
  track: ProjectTrack & { engineType: T }
): EngineParamsMap[T] {
  return track.engines[track.engineType] as EngineParamsMap[T];
}
