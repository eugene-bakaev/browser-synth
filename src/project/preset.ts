import { deepMerge } from '../utils/deepMerge';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import type {
  EngineType,
  EngineParamsMap,
  ProjectTrack,
} from './types';

export const PRESET_SCHEMA_VERSION = 1 as const;

export interface Preset {
  schemaVersion: typeof PRESET_SCHEMA_VERSION;
  engineType: EngineType;
  params: EngineParamsMap[EngineType];
}

// Build a Preset from a known (engineType, params) pair. Clones the params
// so subsequent edits to the caller's object don't bleed into the preset.
export function makePreset<T extends EngineType>(
  engineType: T,
  params: EngineParamsMap[T],
): Preset {
  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    engineType,
    params: structuredClone(params) as EngineParamsMap[EngineType],
  };
}

const DEFAULTS: { [K in EngineType]: EngineParamsMap[K] } = {
  synth: SynthEngine.DEFAULT_PARAMS,
  kick:  KickEngine.DEFAULT_PARAMS,
  hat:   HatEngine.DEFAULT_PARAMS,
  snare: SnareEngine.DEFAULT_PARAMS,
  clap:  ClapEngine.DEFAULT_PARAMS,
};

const ALL_ENGINE_TYPES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap'];

function isEngineType(s: unknown): s is EngineType {
  return typeof s === 'string' && (ALL_ENGINE_TYPES as string[]).includes(s);
}

export function serializePreset(preset: Preset): string {
  return JSON.stringify(preset);
}

// Inverse of serializePreset. Throws on truly unrecoverable input
// (malformed JSON, unknown engineType, missing engineType). Reconciles
// missing params against the engine's DEFAULT_PARAMS so older preset
// files with fewer fields load cleanly.
export function deserializePreset(text: string): Preset {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Preset JSON parse failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Preset root is not an object');
  }

  if (!isEngineType(parsed.engineType)) {
    throw new Error(`Unknown engineType: ${JSON.stringify(parsed.engineType)}`);
  }

  const engineType = parsed.engineType as EngineType;
  const params = deepMerge(DEFAULTS[engineType], parsed.params) as EngineParamsMap[EngineType];

  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    engineType,
    params,
  };
}

// Mutate `track` in place to take on the preset's engine + params.
// Leaves track.mixer, track.steps, and the other-engines' params on
// this track untouched. Preserves the track reference identity, so
// installed Vue watchers on `track` keep firing.
export function applyPreset(track: ProjectTrack, preset: Preset): void {
  track.engineType = preset.engineType;
  Object.assign(
    track.engines[preset.engineType] as unknown as Record<string, unknown>,
    preset.params as unknown as Record<string, unknown>,
  );
}
