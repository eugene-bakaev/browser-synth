// WebSocket sync protocol — message types.
//
// Every message is enveloped with `v: 1` (PROTOCOL_VERSION). Server→client
// messages are typed-only (the type system enforces shape at construction
// time); client→server messages additionally have Zod schemas in ./schema.ts.

import type { Project } from '../project/types.js';
import type { PaletteColor, Handle } from './identity.js';

// Wire path is an array of string/number segments — JSON-pointer-style.
// Example: ['tracks', 0, 'engines', 'synth', 'filterCutoff'].
//
// The server's ConnectionHandler (Task 8) translates between this array form
// and the dot-separated string form ('tracks.0.engines.synth.filterCutoff')
// expected by validatePathAndValue / pathIsWritable in ../project/accept-list.
export type Path = ReadonlyArray<string | number>;

export interface Identity {
  clientId: string;
  color: PaletteColor;
  handle: Handle;
  // Present for authenticated (Google) users; absent/false for guests. clientId
  // stays per-connection-unique — userId is the stable account id carried
  // alongside it (the hook for future per-user features).
  userId?: string | null;
  authenticated?: boolean;
}

// === Client → Server ===

export interface HelloMessage {
  v: 1;
  type: 'hello';
  schemaVersion: number;
  clientId?: string;       // present on resume
  resumeFromOpId?: number; // present on resume
  token?: string;          // present when the user is logged in (Supabase JWT)
}

export interface SetOpClient {
  v: 1;
  type: 'set';
  clientSeq: number;
  path: Path;
  value: unknown;
}

export interface PongMessage {
  v: 1;
  type: 'pong';
}

export interface ResyncMessage {
  v: 1;
  type: 'resync';
  fromOpId: number; // last opId the client has applied; replay everything after it
}

export type ClientMessage = HelloMessage | SetOpClient | PongMessage | ResyncMessage;

// === Server → Client ===

export interface WelcomeMessage {
  v: 1;
  type: 'welcome';
  clientId: string;
  color: PaletteColor;
  handle: Handle;
  userId?: string | null;
  authenticated?: boolean;
  opIdHead: number;
  schemaVersion: number;
  roster: Identity[];
}

export interface SnapshotMessage {
  v: 1;
  type: 'snapshot';
  opId: number;
  project: Project;
}

export interface SetOpBroadcast {
  v: 1;
  type: 'set';
  opId: number;
  clientId: string;
  clientSeq?: number;     // present only on echo to originator
  path: Path;
  value: unknown;
}

export interface SyncCompleteMessage {
  v: 1;
  type: 'sync.complete';
  opId: number;
}

export type NackCode =
  | 'path.invalid'
  | 'value.invalid'
  | 'rate.limited'
  | 'op.duplicate';

export interface NackMessage {
  v: 1;
  type: 'nack';
  clientSeq: number;       // so the client can correlate to a pending outbox op
  code: NackCode;
  message: string;
  details?: unknown;
}

export type ErrorCode =
  | 'schema.version_mismatch'
  | 'protocol.version_mismatch'
  | 'hello.invalid'
  | 'auth.invalid'
  | 'room.full'
  | 'session.not_found'
  | 'resume.unknown_client'
  | 'resume.client_ahead'
  | 'overloaded'
  | 'internal';

// Connection-scoped error (no clientSeq). `fatal: true` indicates the server
// will close the socket after sending; `fatal: false` is informational.
export interface ErrorMessage {
  v: 1;
  type: 'error';
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

export interface PresenceUpdateMessage {
  v: 1;
  type: 'presence.update';
  roster: Identity[];
}

export interface PingMessage {
  v: 1;
  type: 'ping';
}

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | SetOpBroadcast
  | SyncCompleteMessage
  | NackMessage
  | ErrorMessage
  | PresenceUpdateMessage
  | PingMessage;
