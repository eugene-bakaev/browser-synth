import {
  DEFAULT_SYNTH_PARAMS,
  DEFAULT_KICK_PARAMS,
  DEFAULT_HAT_PARAMS,
  DEFAULT_SNARE_PARAMS,
  DEFAULT_CLAP_PARAMS,
} from '../engines/index.js';
import { DEFAULT_MIXER_STATE, PROJECT_SCHEMA_VERSION } from '../index.js';
import type { Project, ProjectTrack, Step } from './types.js';
import { TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS, DEFAULT_BPM } from './constants.js';

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
      synth: structuredClone(DEFAULT_SYNTH_PARAMS),
      kick:  structuredClone(DEFAULT_KICK_PARAMS),
      hat:   structuredClone(DEFAULT_HAT_PARAMS),
      snare: structuredClone(DEFAULT_SNARE_PARAMS),
      clap:  structuredClone(DEFAULT_CLAP_PARAMS),
    },
    mixer: { ...DEFAULT_MIXER_STATE },
    patternLength: 16,
    steps: Array.from({ length: 64 }, () => freshStep()),
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
