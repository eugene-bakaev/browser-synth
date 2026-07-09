import { toRaw } from 'vue';
import { deepMerge } from '../utils/deepMerge';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine } from '../engine/ClapEngine';
import { Synth2Engine } from '../engine/Synth2Engine';
import { Kick2Engine } from '../engine/Kick2Engine';
import { Snare2Engine } from '../engine/Snare2Engine';
import { Hat2Engine } from '../engine/Hat2Engine';
import { Clap2Engine } from '../engine/Clap2Engine';
import type { Step } from '../sequencer/Sequencer';
import {
  type Project,
  type ProjectTrack,
  DEFAULT_MIXER_STATE,
  PROJECT_SCHEMA_VERSION,
} from './types';
import { freshProject, freshTrack } from './factory';
import { migrateToLatest } from './migrations';
import { TRACK_POOL_SIZE, DEFAULT_ENABLED_TRACKS, STEP_BUFFER_SIZE, coerceBpm } from '@fiddle/shared';

function reconcileSteps(loaded: unknown, defaults: Step[]): Step[] {
  if (!Array.isArray(loaded)) {
    return defaults.map(s => ({ ...s }));
  }
  return defaults.map((def, i) => {
    const ov = loaded[i];
    return ov ? deepMerge(def, ov) : { ...def };
  });
}

function reconcileTrack(loaded: unknown, enabled: boolean): ProjectTrack {
  const fresh = freshTrack();
  const t = (typeof loaded === 'object' && loaded !== null) ? (loaded as Partial<ProjectTrack>) : {};
  const loadedEngines = (t as any).engines ?? {};

  const reconciled: ProjectTrack = {
    engineType: (t.engineType as ProjectTrack['engineType']) ?? fresh.engineType,
    // Same rule as normalizeProject on the sync boundary: a stored string
    // wins, anything else (old file, hand-edited JSON) heals to '' = unnamed.
    name: typeof t.name === 'string' ? t.name : fresh.name,
    engines: {
      synth:  deepMerge(SynthEngine.DEFAULT_PARAMS,  loadedEngines.synth),
      kick:   deepMerge(KickEngine.DEFAULT_PARAMS,   loadedEngines.kick),
      hat:    deepMerge(HatEngine.DEFAULT_PARAMS,    loadedEngines.hat),
      snare:  deepMerge(SnareEngine.DEFAULT_PARAMS,  loadedEngines.snare),
      clap:   deepMerge(ClapEngine.DEFAULT_PARAMS,   loadedEngines.clap),
      synth2: deepMerge(Synth2Engine.DEFAULT_PARAMS, loadedEngines.synth2),
      kick2:  deepMerge(Kick2Engine.DEFAULT_PARAMS,  loadedEngines.kick2),
      snare2: deepMerge(Snare2Engine.DEFAULT_PARAMS, loadedEngines.snare2),
      hat2:   deepMerge(Hat2Engine.DEFAULT_PARAMS,   loadedEngines.hat2),
      clap2:  deepMerge(Clap2Engine.DEFAULT_PARAMS,  loadedEngines.clap2),
    },
    mixer: deepMerge(DEFAULT_MIXER_STATE, t.mixer),
    // Clamp on load: a corrupted/hand-edited save with patternLength 0 (or out of
    // range) would otherwise cause `stepIndex % 0 = NaN` at playback. The UI path
    // clamps too; this hardens the persistence path.
    patternLength: typeof t.patternLength === 'number'
      ? Math.max(1, Math.min(STEP_BUFFER_SIZE, t.patternLength))
      : fresh.patternLength,
    steps: reconcileSteps(t.steps, fresh.steps),
    // A stored explicit boolean wins; otherwise fall back to the slot default
    // passed in by reconcileWithDefaults (first N slots enabled).
    enabled: typeof t.enabled === 'boolean' ? t.enabled : enabled,
  };

  // Legacy compat: pre-refactor localStorage / .prj.json files stored
  // playMode on the track. No schema bump (zero users) — silently absorb
  // the old field into synth.mode here. The old playMode field itself
  // gets dropped at T3 when ProjectTrack drops the type.
  const legacy = t as { playMode?: 'mono' | 'chord' };
  if (legacy.playMode === 'chord') {
    reconciled.engines.synth.mode = 'poly';
  }

  return reconciled;
}

export function reconcileWithDefaults(loaded: unknown): Project {
  const p = (typeof loaded === 'object' && loaded !== null) ? (loaded as any) : {};
  const tracks = Array.isArray(p.tracks) ? p.tracks : [];

  const out: Project = {
    ...p,                                              // forward-compat: keep unknown extras
    schemaVersion: PROJECT_SCHEMA_VERSION,
    // Same bpm rule as the sync/server boundary (normalizeProject) — one
    // definition so offline load, file open, and snapshot apply agree.
    bpm: coerceBpm(p.bpm),
    tracks: Array.from({ length: TRACK_POOL_SIZE }, (_, i) =>
      reconcileTrack(tracks[i], i < Math.max(DEFAULT_ENABLED_TRACKS, tracks.length)),
    ) as Project['tracks'],
  };

  return out;
}

// JSON snapshot suitable for writing to disk. Going through
// toRaw strips Vue's reactive proxies so JSON.stringify can't trip on proxy
// metadata or circular reactive structures.
export function serializeProject(project: Project): string {
  return JSON.stringify(toRaw(project));
}

// Inverse of serializeProject: invalid JSON warns + returns a freshProject;
// valid JSON goes through migrateToLatest + reconcileWithDefaults.
// Future-schemaVersion still throws (the only unrecoverable case).
export function deserializeProject(text: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn('Project deserialize failed (invalid JSON), starting fresh:', e);
    return freshProject();
  }
  const migrated = migrateToLatest(parsed);
  return reconcileWithDefaults(migrated);
}

// Mutate `target` in place to match `source`, preserving the reactive proxy
// identity of every nested object. Vue watchers installed on `target` (e.g.
// the per-slice watchers in useSynth's buildAudioState) keep firing because
// the underlying proxy objects are the same — only their fields change.
//
// This is the right semantics for "Open": load a project from disk without
// tearing down the audio graph. The watcher cascade applies params,
// updates mixer gains, and swaps engines exactly as a sequence of manual
// knob turns would.
export function replaceProject(target: Project, source: Project): void {
  target.schemaVersion = source.schemaVersion;
  target.bpm = source.bpm;

  for (let i = 0; i < TRACK_POOL_SIZE; i++) {
    const t = target.tracks[i];
    const s = source.tracks[i];

    t.engineType = s.engineType;
    t.name = s.name;
    t.patternLength = s.patternLength;
    t.enabled = s.enabled;

    for (const engine of ENGINE_KEYS) {
      Object.assign(t.engines[engine], s.engines[engine]);
    }

    Object.assign(t.mixer, s.mixer);

    for (let j = 0; j < STEP_BUFFER_SIZE; j++) {
      Object.assign(t.steps[j], s.steps[j]);
    }
  }
}

const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'] as const;
