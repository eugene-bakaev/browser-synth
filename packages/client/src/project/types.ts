// Project types now live in @fiddle/shared so the server can reason about them
// without dragging in client-only deps. This file is a thin re-export shim so
// existing client imports (`from './types'`, `from '../project/types'`) keep
// resolving. New code should import directly from `@fiddle/shared`.
export type {
  EngineType,
  MixerState,
  EngineParamsMap,
  ProjectTrack,
  Project,
  Step,
} from '@fiddle/shared';
export {
  PROJECT_SCHEMA_VERSION,
  DEFAULT_MIXER_STATE,
  activeParams,
} from '@fiddle/shared';
