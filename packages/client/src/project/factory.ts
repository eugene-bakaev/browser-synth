import type { Step } from '../sequencer/Sequencer';
import {
  DEFAULT_MIXER_STATE,
  DEFAULT_SYNTH_PARAMS,
  DEFAULT_KICK_PARAMS,
  DEFAULT_HAT_PARAMS,
  DEFAULT_SNARE_PARAMS,
  DEFAULT_CLAP_PARAMS,
  PROJECT_SCHEMA_VERSION,
} from '@fiddle/shared';
import {
  type Project,
  type ProjectTrack,
} from './types';

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

export function freshTrack(): ProjectTrack {
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
    steps: Array.from({ length: 16 }, () => freshStep()),
  };
}

export function freshProject(): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: 120,
    tracks: [freshTrack(), freshTrack(), freshTrack(), freshTrack()],
  };
}
