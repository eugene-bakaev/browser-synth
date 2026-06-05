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
import {
  ClientMessageSchema,
  freshProject,
  normalizeProject,
  PROJECT_SCHEMA_VERSION,
  validatePathAndValue,
} from '@fiddle/shared';
import type {
  ErrorCode,
  ErrorMessage,
  HelloMessage,
  Identity,
  NackCode,
  NackMessage,
  PresenceUpdateMessage,
  Project,
  SetOpBroadcast,
  SnapshotMessage,
  SyncCompleteMessage,
  WelcomeMessage,
} from '@fiddle/shared';
import type { RoomStore } from '../room/RoomStore.js';
import { makeIdentity, makeAuthenticatedIdentity } from '../room/identity.js';
import type { ProfileStore } from '../profile/ProfileStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import { Heartbeat } from './Heartbeat.js';
import { TokenBucket } from './rate-limit.js';
import type { RoomConnectionPool, SocketLike } from './SocketLike.js';

export const ROOM_CAP = 4;

// Lightweight log surface so tests can pass a noop and production can pipe to
// Fastify's pino logger.
export type Log = (message: string, ctx?: Record<string, unknown>) => void;

// Resolves the durable project for a room on first join. Returns null when no
// such session exists, which the handler turns into a fatal session.not_found.
// The default is permissive (every room "exists" with a fresh project) so unit
// tests that don't care about session lookup keep their pre-cutover behavior;
// production injects a SessionStore-backed loader (see server.ts).
export interface LoadedSession {
  project: Project;
}
export type SessionLoader = (roomId: string) => Promise<LoadedSession | null>;

const permissiveLoader: SessionLoader = async () => ({ project: freshProject() });

export class ConnectionHandler {
  private clientId: string | null = null;
  private identity: Identity | null = null;
  private helloProcessed = false;
  private bucket = new TokenBucket();
  private readonly heartbeat: Heartbeat;

  constructor(
    private readonly roomId: string,
    private readonly socket: SocketLike,
    private readonly store: RoomStore,
    private readonly pool: RoomConnectionPool,
    private readonly log: Log,
    private readonly verify: (token: string) => Promise<VerifiedClaims | null>,
    private readonly profiles: ProfileStore,
    private readonly loadSession: SessionLoader = permissiveLoader,
    heartbeat?: Heartbeat,
  ) {
    this.heartbeat = heartbeat ?? new Heartbeat(socket);
  }

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
      this.heartbeat.onPong();
      return;
    }

    if (msg.type === 'set') {
      if (!this.clientId) return;
      if (!this.bucket.consume()) {
        this.nack(msg.clientSeq, 'rate.limited', 'op rate limit exceeded');
        return;
      }
      // Wire path is array form; accept-list validator wants dot-separated string.
      const pathStr = msg.path.join('.');
      const v = validatePathAndValue(pathStr, msg.value);
      if (!v.ok) {
        this.nack(msg.clientSeq, v.code, v.message);
        return;
      }
      const r = await this.store.appendOp(this.roomId, {
        clientId: this.clientId,
        clientSeq: msg.clientSeq,
        path: msg.path,
        value: msg.value,
      });
      if (!r.ok) {
        this.nack(msg.clientSeq, 'op.duplicate', 'op already in log');
        return;
      }
      for (const sock of this.pool.all(this.roomId)) {
        const isOrig = sock === this.socket;
        const broadcast: SetOpBroadcast = {
          v: 1,
          type: 'set',
          opId: r.op.opId,
          clientId: this.clientId,
          ...(isOrig ? { clientSeq: msg.clientSeq } : {}),
          path: msg.path,
          value: msg.value,
        };
        sock.send(broadcast);
      }
      return;
    }
  }

  async onClose(): Promise<void> {
    // Stop the heartbeat first — the timer must not fire (and trigger
    // close/send) after the socket has gone away, even if grace-prune below
    // does more async work.
    this.heartbeat.stop();

    if (!this.clientId) {
      // Hello never completed — nothing to clean up.
      return;
    }

    // We're no longer live. Drop from the presence set so we leave the roster,
    // but keep our identity in the registry so a reconnect can resume it.
    await this.store.markDisconnected(this.roomId, this.clientId);

    // The route layer removes this socket from the pool BEFORE invoking
    // onClose, so pool.size reflects the post-departure count.
    if (this.pool.size(this.roomId) === 0) {
      await this.store.startGrace(this.roomId, () => {
        void this.store.pruneRoom(this.roomId);
        this.log('room pruned after grace', { roomId: this.roomId });
      });
      return;
    }

    // Peers still here: fan out a fresh roster (connected only) so their UIs drop us.
    const roster = await this.store.listConnected(this.roomId);
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

    // Session-scoped room init (Plan 3): a room is materialised only for a real
    // session. If it isn't already live in memory, load its durable project; a
    // null result means "no such session" — reject so the client bounces to the
    // lobby. Auto-mint is gone.
    let seed: () => Project = freshProject;
    const alreadyLive = (await this.store.peekProject(this.roomId)) !== null;
    if (!alreadyLive) {
      const loaded = await this.loadSession(this.roomId);
      if (!loaded) {
        this.fatal('session.not_found', `session ${this.roomId} does not exist`);
        return;
      }
      seed = () => normalizeProject(loaded.project);
    }
    const { opIdHead } = await this.store.getOrCreate(this.roomId, seed);
    await this.store.cancelGrace(this.roomId);

    let identity: Identity | null = null;
    let resumeIdentityWarning: 'unknown_client' | null = null;

    if (msg.token) {
      const claims = await this.verify(msg.token);
      if (!claims) {
        this.fatal('auth.invalid', 'invalid or expired auth token');
        return;
      }
      const present = await this.store.listConnected(this.roomId);
      const username = await this.profiles.getUsername(claims.userId);
      identity = makeAuthenticatedIdentity(present, {
        userId: claims.userId,
        handle: username ?? claims.googleName,
      });
      await this.store.setIdentity(this.roomId, identity);
    } else {
      // Guest path (unchanged): resume an existing identity if the client
      // presented a known clientId, else mint a fresh one. Assign a
      // color/handle distinct from currently-connected peers (departed members
      // free their color for reuse).
      if (msg.clientId) {
        const existing = await this.store.getIdentity(this.roomId, msg.clientId);
        if (existing) {
          identity = existing;
        } else {
          resumeIdentityWarning = 'unknown_client';
        }
      }
      if (!identity) {
        const present = await this.store.listConnected(this.roomId);
        identity = makeIdentity(present);
        await this.store.setIdentity(this.roomId, identity);
      }
    }

    this.clientId = identity.clientId;
    this.identity = identity;
    this.helloProcessed = true;

    // Now live: include us in the presence roster broadcast below.
    await this.store.markConnected(this.roomId, identity.clientId);

    const roster = await this.store.listConnected(this.roomId);
    const welcome: WelcomeMessage = {
      v: 1,
      type: 'welcome',
      clientId: identity.clientId,
      color: identity.color,
      handle: identity.handle,
      userId: identity.userId ?? null,
      authenticated: identity.authenticated ?? false,
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

    this.heartbeat.start();

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

  private nack(clientSeq: number, code: NackCode, message: string): void {
    const n: NackMessage = { v: 1, type: 'nack', clientSeq, code, message };
    this.socket.send(n);
  }
}
