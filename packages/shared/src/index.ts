// @fiddle/shared — types and constants that both client and server need to
// agree on. For the initial backend scaffold only the truly portable symbols
// live here. The fuller wire-format types (Project, ProjectTrack, the engine
// param types) will move here as part of the sync-layer work.

export type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

export interface MixerState {
  volume: number;       // slider 0..1; log mapping is the consumer's job
  muted: boolean;
  soloed: boolean;
}

export const DEFAULT_MIXER_STATE: MixerState = {
  volume: 0.9,
  muted: false,
  soloed: false,
};

// Bump only on breaking schema changes. Additive changes are handled by the
// client-side reconcileWithDefaults at load time.
export const PROJECT_SCHEMA_VERSION = 2 as const;

// Engine param shapes + defaults (per-engine modules under ./engines/).
// Moved out of the client `engine/*Engine.ts` files so the server can construct
// a default Project and validate paths without dragging in DOM/Web Audio types.
export * from './engines/index.js';

// Project shape (Step, ProjectTrack, Project) + freshProject factory. Lives in
// shared so both client and server can build a default Project and reason about
// it as the canonical wire format.
export * from './project/index.js';

// WebSocket sync protocol: PROTOCOL_VERSION, identity constants (PALETTE,
// HANDLES), message type definitions, and Zod schemas for inbound messages.
export * from './protocol/index.js';

// Wire-path helpers (setDeep, pathKey) shared by client + server.
export * from './path.js';

// Session settings shape + defaults, shared by the lobby UI and the server.
export * from './session/settings.js';

// Lobby list entry wire shape (GET /api/sessions response).
export * from './session/lobby.js';

// Session HTTP API request schemas (create/patch bodies).
export * from './session/api.js';
