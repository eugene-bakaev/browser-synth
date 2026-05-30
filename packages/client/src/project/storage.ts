import { toRaw, watch, type WatchStopHandle } from 'vue';
import { deepMerge } from '../utils/deepMerge';
import { debounce } from '../utils/debounce';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine } from '../engine/ClapEngine';
import type { Step } from '../sequencer/Sequencer';
import {
  type Project,
  type ProjectTrack,
  DEFAULT_MIXER_STATE,
  PROJECT_SCHEMA_VERSION,
} from './types';
import { freshProject, freshTrack } from './factory';
import { migrateToLatest } from './migrations';

const STORAGE_KEY = 'fiddle:project';
const SAVE_DEBOUNCE_MS = 500;

function reconcileSteps(loaded: unknown, defaults: Step[]): Step[] {
  if (!Array.isArray(loaded)) {
    return defaults.map(s => ({ ...s }));
  }
  return defaults.map((def, i) => {
    const ov = loaded[i];
    return ov ? deepMerge(def, ov) : { ...def };
  });
}

function reconcileTrack(loaded: unknown): ProjectTrack {
  const fresh = freshTrack();
  const t = (typeof loaded === 'object' && loaded !== null) ? (loaded as Partial<ProjectTrack>) : {};
  const loadedEngines = (t as any).engines ?? {};

  const reconciled: ProjectTrack = {
    engineType: (t.engineType as ProjectTrack['engineType']) ?? fresh.engineType,
    engines: {
      synth: deepMerge(SynthEngine.DEFAULT_PARAMS, loadedEngines.synth),
      kick:  deepMerge(KickEngine.DEFAULT_PARAMS,  loadedEngines.kick),
      hat:   deepMerge(HatEngine.DEFAULT_PARAMS,   loadedEngines.hat),
      snare: deepMerge(SnareEngine.DEFAULT_PARAMS, loadedEngines.snare),
      clap:  deepMerge(ClapEngine.DEFAULT_PARAMS,  loadedEngines.clap),
    },
    mixer: deepMerge(DEFAULT_MIXER_STATE, t.mixer),
    patternLength: typeof t.patternLength === 'number' ? t.patternLength : fresh.patternLength,
    steps: reconcileSteps(t.steps, fresh.steps),
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
  const fresh = freshProject();
  const p = (typeof loaded === 'object' && loaded !== null) ? (loaded as any) : {};
  const tracks = Array.isArray(p.tracks) ? p.tracks : [];

  const out: Project = {
    ...p,                                              // forward-compat: keep unknown extras
    schemaVersion: PROJECT_SCHEMA_VERSION,
    bpm: typeof p.bpm === 'number' ? p.bpm : fresh.bpm,
    tracks: [0, 1, 2, 3].map(i => reconcileTrack(tracks[i])) as Project['tracks'],
  };

  return out;
}

export function loadProject(): Project {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return freshProject();
  }
  if (raw === null) return freshProject();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('Project load failed (invalid JSON), starting fresh:', e);
    return freshProject();
  }

  const migrated = migrateToLatest(parsed);
  return reconcileWithDefaults(migrated);
}

export function installAutoSave(project: Project): () => void {
  const save = debounce(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toRaw(project)));
    } catch (e) {
      console.warn('Project save failed:', e);
    }
  }, SAVE_DEBOUNCE_MS);

  const stop: WatchStopHandle = watch(project, save, { deep: true });

  return () => {
    save.cancel();
    stop();
  };
}

// JSON snapshot suitable for writing to disk or localStorage. Going through
// toRaw strips Vue's reactive proxies so JSON.stringify can't trip on proxy
// metadata or circular reactive structures.
export function serializeProject(project: Project): string {
  return JSON.stringify(toRaw(project));
}

// Inverse of serializeProject. Mirrors loadProject's parse step: invalid
// JSON warns + returns a freshProject; valid JSON goes through
// migrateToLatest + reconcileWithDefaults. Future-schemaVersion still
// throws (the only unrecoverable case).
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

  for (let i = 0; i < 4; i++) {
    const t = target.tracks[i];
    const s = source.tracks[i];

    t.engineType = s.engineType;
    t.patternLength = s.patternLength;

    for (const engine of ENGINE_KEYS) {
      Object.assign(t.engines[engine], s.engines[engine]);
    }

    Object.assign(t.mixer, s.mixer);

    for (let j = 0; j < 64; j++) {
      Object.assign(t.steps[j], s.steps[j]);
    }
  }
}

const ENGINE_KEYS = ['synth', 'kick', 'hat', 'snare', 'clap'] as const;
