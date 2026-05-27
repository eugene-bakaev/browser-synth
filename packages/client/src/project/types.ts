import type { SynthEngineParams } from '../engine/SynthEngine';
import type { KickEngineParams }  from '../engine/KickEngine';
import type { HatEngineParams }   from '../engine/HatEngine';
import type { SnareEngineParams } from '../engine/SnareEngine';
import type { ClapEngineParams }  from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';

// Bump only on breaking schema changes — additive changes are handled by
// `reconcileWithDefaults` at load time. See spec §6.1.
export const PROJECT_SCHEMA_VERSION = 1 as const;

export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

export interface MixerState {
  volume: number;       // slider 0..1; the log mapping happens in useSynth (U4)
  muted: boolean;
  soloed: boolean;
}

export const DEFAULT_MIXER_STATE: MixerState = {
  volume: 0.9,          // 0 dB unity under the U4 dB curve
  muted: false,
  soloed: false,
};

export interface EngineParamsMap {
  synth: SynthEngineParams;
  kick: KickEngineParams;
  hat: HatEngineParams;
  snare: SnareEngineParams;
  clap: ClapEngineParams;
}

export interface ProjectTrack {
  engineType: EngineType;
  engines: EngineParamsMap;     // dense — all 5 engines always present
  mixer: MixerState;
  steps: Step[];                // length 16
}

export interface Project {
  schemaVersion: 1;
  bpm: number;
  tracks: [ProjectTrack, ProjectTrack, ProjectTrack, ProjectTrack];
}

// Type-safe accessor: returns the active engine's params, narrowed by engineType.
export function activeParams<T extends EngineType>(
  track: ProjectTrack & { engineType: T }
): EngineParamsMap[T] {
  return track.engines[track.engineType] as EngineParamsMap[T];
}
