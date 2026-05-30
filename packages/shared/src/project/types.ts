import type {
  SynthEngineParams,
  KickEngineParams,
  HatEngineParams,
  SnareEngineParams,
  ClapEngineParams,
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
}

export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;
  mixer: MixerState;
  // `steps` is always a fixed 64-element buffer. `patternLength` (1..64) is the
  // play/render window; steps at indices >= patternLength keep their data but
  // do not play or render. Shrinking the window is therefore non-destructive.
  patternLength: number;
  steps: Step[];
}

export interface Project {
  schemaVersion: 2;
  bpm: number;
  tracks: [ProjectTrack, ProjectTrack, ProjectTrack, ProjectTrack];
}

export function activeParams<T extends EngineType>(
  track: ProjectTrack & { engineType: T }
): EngineParamsMap[T] {
  return track.engines[track.engineType] as EngineParamsMap[T];
}
