import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { resolveCorsOrigin } from './cors.js';
import postgres from 'postgres';
import { freshProject } from '@fiddle/shared';
import { healthRoute } from './routes/health.js';
import { wsRoute } from './routes/ws.js';
import { InMemoryRoomStore } from './room/InMemoryRoomStore.js';
import { ConnectionPool } from './sync/ConnectionPool.js';
import { verifyToken, remoteJwks } from './auth/verifyToken.js';
import { InMemoryProfileStore } from './profile/InMemoryProfileStore.js';
import { PostgresProfileStore } from './profile/PostgresProfileStore.js';
import type { ProfileStore } from './profile/ProfileStore.js';
import type { VerifiedClaims } from './auth/verifyToken.js';
import { InMemorySessionStore } from './session/InMemorySessionStore.js';
import { PostgresSessionStore } from './session/PostgresSessionStore.js';
import type { SessionStore } from './session/SessionStore.js';
import { SessionSync } from './session/SessionSync.js';
import { sessionsRoute } from './routes/sessions.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const store = new InMemoryRoomStore();
  const pool = new ConnectionPool();

  // Auth + profiles are optional: with no Supabase env the server runs
  // guest-only (verify always rejects tokens; profile store is empty).
  const jwksUrl = process.env.SUPABASE_JWKS_URL;
  const dbUrl = process.env.DATABASE_URL;

  let verify: (token: string) => Promise<VerifiedClaims | null>;
  if (jwksUrl) {
    const jwks = remoteJwks(jwksUrl);
    verify = (token: string) => verifyToken(token, jwks);
  } else {
    verify = async () => null;
  }

  // One Postgres connection backs both privileged read/write stores when a DB is
  // configured; otherwise both fall back to in-memory.
  const sql = dbUrl ? postgres(dbUrl) : null;
  const profiles: ProfileStore = sql
    ? new PostgresProfileStore(sql)
    : new InMemoryProfileStore();
  const sessions: SessionStore = sql
    ? new PostgresSessionStore(sql)
    : new InMemorySessionStore();

  const sessionSync = new SessionSync(
    store,
    sessions,
    (msg, fields) => app.log.info(fields ?? {}, msg),
  );

  // Production session loader: a room exists iff it has a session row. Seed its
  // in-memory project from the durable snapshot (falling back to a fresh project
  // for a session whose snapshot hasn't been flushed yet).
  const loadSession = async (roomId: string) => {
    const record = await sessions.get(roomId);
    if (!record) return null;
    const project = await sessions.getSnapshot(roomId);
    return { project: project ?? freshProject() };
  };

  // CORS first so its hooks apply to every route (incl. /api preflight). The
  // client and server are cross-origin in prod; see resolveCorsOrigin.
  app.register(cors, { origin: resolveCorsOrigin() });
  app.register(websocket);
  app.register(healthRoute);
  app.register(async (a) =>
    sessionsRoute(a, { sessions, verify, liveCounts: () => store.roomMemberCounts() }),
  );
  app.register(async (a) => wsRoute(a, { store, pool, verify, profiles, sessionSync, loadSession }));

  // Autosave: periodic sweep of dirty rooms + a final flush on graceful shutdown
  // (SIGTERM → app.close() → onClose). stop() first so no sweep races the flush.
  sessionSync.start();
  app.addHook('onClose', async () => {
    sessionSync.stop();
    await sessionSync.flushAllDirty();
  });

  return app;
}
