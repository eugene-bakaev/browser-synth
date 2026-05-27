import type { SynthEngineParams } from '../engine/SynthEngine';
import type { KickEngineParams }  from '../engine/KickEngine';
import type { HatEngineParams }   from '../engine/HatEngine';
import type { SnareEngineParams } from '../engine/SnareEngine';
import type { ClapEngineParams }  from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';
import type { EngineType, MixerState } from '@fiddle/shared';
import { PROJECT_SCHEMA_VERSION, DEFAULT_MIXER_STATE } from '@fiddle/shared';

// Re-export so existing consumers (via ./project barrel) keep working.
export { PROJECT_SCHEMA_VERSION, DEFAULT_MIXER_STATE };
export type { EngineType, MixerState };

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
  steps: Step[];
}

export interface Project {
  schemaVersion: 1;
  bpm: number;
  tracks: [ProjectTrack, ProjectTrack, ProjectTrack, ProjectTrack];
}

export function activeParams<T extends EngineType>(
  track: ProjectTrack & { engineType: T }
): EngineParamsMap[T] {
  return track.engines[track.engineType] as EngineParamsMap[T];
}
