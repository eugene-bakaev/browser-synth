export { PROTOCOL_VERSION } from './version.js';
export { PALETTE, HANDLES } from './identity.js';
export type { PaletteColor, Handle } from './identity.js';
export type {
  Path,
  Identity,
  HelloMessage,
  SetOpClient,
  PongMessage,
  ClientMessage,
  WelcomeMessage,
  SnapshotMessage,
  SetOpBroadcast,
  SyncCompleteMessage,
  NackCode,
  NackMessage,
  ErrorCode,
  ErrorMessage,
  PresenceUpdateMessage,
  PingMessage,
  ServerMessage,
} from './types.js';
export {
  HelloSchema,
  SetOpClientSchema,
  PongSchema,
  ClientMessageSchema,
} from './schema.js';
