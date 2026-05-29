// Transport-agnostic abstractions for the ConnectionHandler.
//
// The route layer (Task 10) is responsible for adapting Fastify's `ws` socket
// (RawData + JSON.stringify) into a `SocketLike` and for maintaining the
// `RoomConnectionPool` — adding sockets on connect and removing them BEFORE
// invoking ConnectionHandler#onClose. Keeping these shapes minimal lets us
// drive the handler from plain test doubles.

import type { ServerMessage } from '@fiddle/shared';

export interface SocketLike {
  // Match WebSocket.readyState semantics: 0 CONNECTING, 1 OPEN, 2 CLOSING,
  // 3 CLOSED. The handler only sends on OPEN; the route layer is free to keep
  // this strict or loose.
  readonly readyState: number;
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

export interface RoomConnectionPool {
  // Every connected socket in `roomId` except `exclude`. Used for broadcasts
  // that should not echo back to the originator (presence updates after a new
  // client joins, op broadcasts originating from this client, …).
  others(roomId: string, exclude: SocketLike): SocketLike[];
  // Every connected socket in `roomId`, including the originator.
  all(roomId: string): SocketLike[];
  // Live count of sockets in `roomId`.
  size(roomId: string): number;
}
