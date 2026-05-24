import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';
import {
  type Project,
  type ProjectTrack,
  DEFAULT_MIXER_STATE,
  PROJECT_SCHEMA_VERSION,
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
      synth: structuredClone(SynthEngine.DEFAULT_PARAMS),
      kick:  structuredClone(KickEngine.DEFAULT_PARAMS),
      hat:   structuredClone(HatEngine.DEFAULT_PARAMS),
      snare: structuredClone(SnareEngine.DEFAULT_PARAMS),
      clap:  structuredClone(ClapEngine.DEFAULT_PARAMS),
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
