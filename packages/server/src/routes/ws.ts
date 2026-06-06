// Real /ws/:roomId route: adapts Fastify's underlying `ws` socket to a
// SocketLike, registers it with the shared ConnectionPool, and delegates
// inbound frames / close to a per-connection ConnectionHandler.
//
// Lifecycle invariants worth preserving:
//   * The pool entry is removed BEFORE ConnectionHandler#onClose runs, so the
//     handler sees an accurate `pool.size === 0` when it's the last socket.
//   * JSON.parse errors on the wire don't crash the listener — the handler
//     treats `null` as an invalid frame and replies with an error.
//   * onMessage / onClose are async; their Promise rejections are caught and
//     logged so an unhandled rejection cannot kill the process.

import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { ConnectionHandler } from '../sync/ConnectionHandler.js';
import type { SocketLike } from '../sync/SocketLike.js';
import type { ServerMessage } from '@fiddle/shared';
import type { RoomStore } from '../room/RoomStore.js';
import type { ConnectionPool } from '../sync/ConnectionPool.js';
import type { ProfileStore } from '../profile/ProfileStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import type { SessionSync } from '../session/SessionSync.js';
import type { SessionLoader } from '../sync/ConnectionHandler.js';

interface Deps {
  store: RoomStore;
  pool: ConnectionPool;
  verify: (token: string) => Promise<VerifiedClaims | null>;
  profiles: ProfileStore;
  sessionSync: SessionSync;
  loadSession: SessionLoader;
}

function adaptSocket(ws: WebSocket): SocketLike {
  return {
    send(msg: ServerMessage) {
      ws.send(JSON.stringify(msg));
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
    get readyState() {
      return ws.readyState;
    },
  };
}

export async function wsRoute(app: FastifyInstance, deps: Deps) {
  app.get('/ws/:roomId', { websocket: true }, (socket, req) => {
    const { roomId } = req.params as { roomId: string };
    const adapted = adaptSocket(socket as unknown as WebSocket);
    deps.pool.add(roomId, adapted);
    app.log.info(
      { roomId, conns: deps.pool.totalConnections(), rooms: deps.pool.roomCount() },
      'ws open',
    );

    const handler = new ConnectionHandler(
      roomId,
      adapted,
      deps.store,
      deps.pool,
      (msg, fields) => app.log.info(fields ?? {}, msg),
      deps.verify,
      deps.profiles,
      deps.loadSession,
    );
    // Arm the hello deadline immediately so a socket that opens but never
    // completes the handshake can't squat in the pool (no heartbeat pre-hello).
    handler.onOpen();

    socket.on('message', (raw: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        parsed = null;
      }
      handler.onMessage(parsed).catch((err) => app.log.error({ err }, 'ws onMessage'));
    });

    socket.on('close', (code: number) => {
      // Remove from pool BEFORE onClose so pool.size === 0 means "last socket".
      deps.pool.remove(roomId, adapted);
      const roomNowEmpty = deps.pool.size(roomId) === 0;
      app.log.info(
        { roomId, code, conns: deps.pool.totalConnections(), rooms: deps.pool.roomCount() },
        'ws close',
      );
      handler.onClose().catch((err) => app.log.error({ err }, 'ws onClose'));
      // Persist the room's project on every disconnect (and prune guest sessions
      // when the room empties). Independent of onClose; both read live state.
      deps.sessionSync
        .handleDisconnect(roomId, roomNowEmpty)
        .catch((err) => app.log.error({ err }, 'session disconnect'));
    });
  });
}
