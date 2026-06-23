import {
  DEFAULT_SYNTH_PARAMS,
  DEFAULT_KICK_PARAMS,
  DEFAULT_HAT_PARAMS,
  DEFAULT_SNARE_PARAMS,
  DEFAULT_CLAP_PARAMS,
  DEFAULT_SYNTH2_PARAMS,
  DEFAULT_KICK2_PARAMS,
  DEFAULT_SNARE2_PARAMS,
  DEFAULT_HAT2_PARAMS,
  DEFAULT_CLAP2_PARAMS,
} from '../engines/index.js';
import { DEFAULT_MIXER_STATE, PROJECT_SCHEMA_VERSION } from '../index.js';
import type { Project, ProjectTrack, Step } from './types.js';
import {
  TRACK_POOL_SIZE,
  DEFAULT_ENABLED_TRACKS,
  DEFAULT_BPM,
  STEP_BUFFER_SIZE,
  DEFAULT_PATTERN_LENGTH,
} from './constants.js';

export { TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS };

export function freshStep(): Step {
  return {
    note: null,
    octave: 4,
    length: 1,
    velocity: 0.8,
    muted: false,
    isChord: false,
    chordType: 'maj',
  };
}

export function freshTrack(enabled = true): ProjectTrack {
  return {
    engineType: 'synth',
    engines: {
      synth:  structuredClone(DEFAULT_SYNTH_PARAMS),
      kick:   structuredClone(DEFAULT_KICK_PARAMS),
      hat:    structuredClone(DEFAULT_HAT_PARAMS),
      snare:  structuredClone(DEFAULT_SNARE_PARAMS),
      clap:   structuredClone(DEFAULT_CLAP_PARAMS),
      synth2: structuredClone(DEFAULT_SYNTH2_PARAMS),
      kick2:  structuredClone(DEFAULT_KICK2_PARAMS),
      snare2: structuredClone(DEFAULT_SNARE2_PARAMS),
      hat2:   structuredClone(DEFAULT_HAT2_PARAMS),
      clap2:  structuredClone(DEFAULT_CLAP2_PARAMS),
    },
    mixer: { ...DEFAULT_MIXER_STATE },
    patternLength: DEFAULT_PATTERN_LENGTH,
    steps: Array.from({ length: STEP_BUFFER_SIZE }, () => freshStep()),
    enabled,
  };
}

export function freshProject(): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: DEFAULT_BPM,
    tracks: Array.from({ length: TRACK_POOL_SIZE }, (_, i) =>
      freshTrack(i < DEFAULT_ENABLED_TRACKS),
    ),
  };
}
