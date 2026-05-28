// First half of the WebSocket lifecycle, lifted out of the Fastify route so
// it's unit-testable with mocks. Responsibilities:
//
//   * Parse + validate every inbound frame with ClientMessageSchema.
//   * Enforce hello-first ordering; reject duplicates / unknown frames fatally.
//   * On hello: resolve identity (fresh or resumed), send welcome, catch the
//     client up via replay-from-ring-buffer or snapshot, then sync.complete.
//   * Broadcast presence.update to peers after the new client is fully live.
//   * On close: trigger the grace timer if this was the last socket; otherwise
//     fan a fresh roster to remaining peers.
//
// Task 8 will fill in `set` op handling; Task 9 will add pong/heartbeat hooks.

import {
  ClientMessageSchema,
  freshProject,
  PROJECT_SCHEMA_VERSION,
} from '@fiddle/shared';
import type {
  ErrorCode,
  ErrorMessage,
  HelloMessage,
  Identity,
  PresenceUpdateMessage,
  SetOpBroadcast,
  SnapshotMessage,
  SyncCompleteMessage,
  WelcomeMessage,
} from '@fiddle/shared';
import type { RoomStore } from '../room/RoomStore.js';
import { makeIdentity } from '../room/identity.js';
import type { RoomConnectionPool, SocketLike } from './SocketLike.js';

export const ROOM_CAP = 4;

// Lightweight log surface so tests can pass a noop and production can pipe to
// Fastify's pino logger.
export type Log = (message: string, ctx?: Record<string, unknown>) => void;

export class ConnectionHandler {
  private clientId: string | null = null;
  private identity: Identity | null = null;
  private helloProcessed = false;

  constructor(
    private readonly roomId: string,
    private readonly socket: SocketLike,
    private readonly store: RoomStore,
    private readonly pool: RoomConnectionPool,
    private readonly log: Log,
  ) {}

  async onMessage(raw: unknown): Promise<void> {
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.fatal('hello.invalid', 'malformed message');
      return;
    }
    const msg = parsed.data;

    if (msg.type === 'hello') {
      if (this.helloProcessed) {
        this.fatal('hello.invalid', 'duplicate hello');
        return;
      }
      await this.handleHello(msg);
      return;
    }

    if (!this.helloProcessed) {
      this.fatal('hello.invalid', 'first message must be hello');
      return;
    }

    if (msg.type === 'pong') {
      // Heartbeat (Task 9) will hook in here.
      return;
    }

    if (msg.type === 'set') {
      // Op handling (Task 8) will hook in here.
      this.log('set op received (stub)', {
        roomId: this.roomId,
        clientId: this.clientId,
        clientSeq: msg.clientSeq,
      });
      return;
    }
  }

  async onClose(): Promise<void> {
    if (!this.clientId) {
      // Hello never completed — nothing to clean up.
      return;
    }

    // The route layer removes this socket from the pool BEFORE invoking
    // onClose, so pool.size reflects the post-departure count.
    if (this.pool.size(this.roomId) === 0) {
      await this.store.startGrace(this.roomId, () => {
        void this.store.pruneRoom(this.roomId);
        this.log('room pruned after grace', { roomId: this.roomId });
      });
      return;
    }

    // Peers still here: fan out a fresh roster so their UIs drop us.
    const roster = await this.store.listIdentities(this.roomId);
    const update: PresenceUpdateMessage = {
      v: 1,
      type: 'presence.update',
      roster,
    };
    for (const peer of this.pool.others(this.roomId, this.socket)) {
      peer.send(update);
    }
  }

  private async handleHello(msg: HelloMessage): Promise<void> {
    if (msg.schemaVersion !== PROJECT_SCHEMA_VERSION) {
      this.fatal(
        'schema.version_mismatch',
        `expected schema ${PROJECT_SCHEMA_VERSION}, got ${msg.schemaVersion}`,
      );
      return;
    }

    if (this.pool.size(this.roomId) > ROOM_CAP) {
      this.fatal('room.full', `room ${this.roomId} is at capacity`);
      return;
    }

    const { opIdHead } = await this.store.getOrCreate(this.roomId, freshProject);
    await this.store.cancelGrace(this.roomId);

    let identity: Identity | null = null;
    let resumeIdentityWarning: 'unknown_client' | null = null;

    if (msg.clientId) {
      const existing = await this.store.getIdentity(this.roomId, msg.clientId);
      if (existing) {
        identity = existing;
      } else {
        resumeIdentityWarning = 'unknown_client';
      }
    }

    if (!identity) {
      const roster = await this.store.listIdentities(this.roomId);
      identity = makeIdentity(roster);
      await this.store.setIdentity(this.roomId, identity);
    }

    this.clientId = identity.clientId;
    this.identity = identity;
    this.helloProcessed = true;

    const roster = await this.store.listIdentities(this.roomId);
    const welcome: WelcomeMessage = {
      v: 1,
      type: 'welcome',
      clientId: identity.clientId,
      color: identity.color,
      handle: identity.handle,
      opIdHead,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      roster,
    };
    this.socket.send(welcome);

    // Intentional ordering: the welcome lands first (so the client has its
    // identity context), then the informational error tells it the resumed
    // clientId wasn't recognised and a fresh identity was minted.
    if (resumeIdentityWarning === 'unknown_client') {
      const err: ErrorMessage = {
        v: 1,
        type: 'error',
        code: 'resume.unknown_client',
        message: `clientId ${msg.clientId} not found in room (grace expired or never seen)`,
        fatal: false,
      };
      this.socket.send(err);
    }

    // Catch-up: replay from ring buffer when possible, otherwise snapshot.
    const resumeFrom = msg.resumeFromOpId ?? -1;
    if (resumeFrom >= 0 && resumeFrom <= opIdHead) {
      const ops = await this.store.getOpsSince(this.roomId, resumeFrom);
      if (ops === null) {
        await this.sendSnapshot(opIdHead);
      } else {
        for (const op of ops) {
          // Replay path: omit clientSeq. clientSeq is only set on the echo to
          // the originator of an op, not on backfill/broadcast frames.
          const broadcast: SetOpBroadcast = {
            v: 1,
            type: 'set',
            opId: op.opId,
            clientId: op.clientId,
            path: op.path,
            value: op.value,
          };
          this.socket.send(broadcast);
        }
      }
    } else if (resumeFrom > opIdHead) {
      const err: ErrorMessage = {
        v: 1,
        type: 'error',
        code: 'resume.client_ahead',
        message: `client opId ${resumeFrom} is ahead of server head ${opIdHead}`,
        fatal: false,
      };
      this.socket.send(err);
      await this.sendSnapshot(opIdHead);
    } else {
      // Fresh join (resumeFrom === -1).
      await this.sendSnapshot(opIdHead);
    }

    const complete: SyncCompleteMessage = {
      v: 1,
      type: 'sync.complete',
      opId: opIdHead,
    };
    this.socket.send(complete);

    // Tell remaining peers the new client is now present. They've already got
    // each other in their rosters; this update brings us into view.
    const presence: PresenceUpdateMessage = {
      v: 1,
      type: 'presence.update',
      roster,
    };
    for (const peer of this.pool.others(this.roomId, this.socket)) {
      peer.send(presence);
    }

    this.log('client live', {
      roomId: this.roomId,
      clientId: this.clientId,
      handle: this.identity.handle,
    });
  }

  private async sendSnapshot(opIdHead: number): Promise<void> {
    const { project } = await this.store.getOrCreate(this.roomId, freshProject);
    const snapshot: SnapshotMessage = {
      v: 1,
      type: 'snapshot',
      opId: opIdHead,
      project,
    };
    this.socket.send(snapshot);
  }

  private fatal(code: ErrorCode, message: string): void {
    const err: ErrorMessage = {
      v: 1,
      type: 'error',
      code,
      message,
      fatal: true,
    };
    this.socket.send(err);
    // 1008 = Policy Violation, the closest match in the standard codes for
    // protocol-level rejections.
    this.socket.close(1008, code);
  }
}
