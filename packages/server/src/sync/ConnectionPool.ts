// Per-server registry of open WebSocket connections, partitioned by roomId.
//
// Owns no business logic — purely a transport-side index used by
// ConnectionHandler to broadcast to peers and to learn when a room has gone
// empty (so the grace-period timer can start). One instance per server (see
// buildServer()), shared across rooms.
//
// readyState filtering: `others`/`all`/`size` only return OPEN sockets
// (readyState === 1). A CLOSING socket should not receive broadcasts, and the
// last-socket-out semantics in ConnectionHandler#onClose rely on `size === 0`
// being exact once the route layer has removed the closing socket.

import type { RoomConnectionPool, SocketLike } from './SocketLike.js';

export class ConnectionPool implements RoomConnectionPool {
  private rooms = new Map<string, Set<SocketLike>>();

  add(roomId: string, socket: SocketLike): void {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set());
    this.rooms.get(roomId)!.add(socket);
  }

  remove(roomId: string, socket: SocketLike): void {
    const set = this.rooms.get(roomId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.rooms.delete(roomId);
  }

  others(roomId: string, exclude: SocketLike): SocketLike[] {
    const set = this.rooms.get(roomId);
    if (!set) return [];
    return [...set].filter((s) => s !== exclude && s.readyState === 1);
  }

  all(roomId: string): SocketLike[] {
    return [...(this.rooms.get(roomId) ?? [])].filter((s) => s.readyState === 1);
  }

  size(roomId: string): number {
    return this.all(roomId).length;
  }

  // Leak gauges (raw membership, NOT readyState-filtered): a socket that should
  // have been removed but wasn't still counts here. If totalConnections /
  // roomCount stay elevated when no one is using the app, those are stale
  // connections leaking (and, since a non-empty room blocks grace pruning,
  // leaking its ~224 KB project too). Used by the periodic memory gauge.
  totalConnections(): number {
    let n = 0;
    for (const set of this.rooms.values()) n += set.size;
    return n;
  }

  roomCount(): number {
    return this.rooms.size;
  }
}
