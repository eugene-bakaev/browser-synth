import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { resolveCorsOrigin } from './cors.js';
import postgres from 'postgres';
import { POSTGRES_OPTIONS } from './db/postgresOptions.js';
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
import { instrumentSessionStore, instrumentProfileStore } from './otel/db.js';
import { makeLog } from './otel/log.js';

export function buildServer(): FastifyInstance {
  // trustProxy: Render terminates TLS at its proxy, so req.ip is the proxy
  // address unless x-forwarded-for is honored. The per-IP create rate limit
  // needs the real client IP; direct connections bypassing the proxy aren't
  // possible on Render, so trusting the header is safe there.
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true });
  const log = makeLog(app);
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
  const sql = dbUrl ? postgres(dbUrl, POSTGRES_OPTIONS) : null;
  const profiles: ProfileStore = instrumentProfileStore(
    sql ? new PostgresProfileStore(sql) : new InMemoryProfileStore(),
  );
  const sessions: SessionStore = instrumentSessionStore(
    sql ? new PostgresSessionStore(sql) : new InMemorySessionStore(),
  );

  const sessionSync = new SessionSync(store, sessions, log);

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
  app.register(async (a) =>
    wsRoute(a, {
      store,
      pool,
      verify,
      profiles,
      sessionSync,
      loadSession,
      onGraceExpire: (roomId) => sessionSync.handleGraceExpiry(roomId),
      log,
    }),
  );

  // Autosave: periodic sweep of dirty rooms + a final flush on graceful shutdown
  // (SIGTERM → app.close() → onClose). stop() first so no sweep races the flush.
  sessionSync.start();

  // Leak / memory gauge: every 60s log live connection + room counts alongside
  // process memory. On the 512 MB Render instance a leak shows up here as conns
  // and/or rooms staying elevated when no one is connected, with rss climbing
  // toward the limit (→ GC thrash → OOM restart). unref so it can't keep the
  // process alive on shutdown. NODE_ENV==='test' suppresses logging entirely.
  const gauge = setInterval(() => {
    const m = process.memoryUsage();
    app.log.info(
      {
        conns: pool.totalConnections(),
        rooms: pool.roomCount(),
        rssMB: Math.round(m.rss / 1024 / 1024),
        heapUsedMB: Math.round(m.heapUsed / 1024 / 1024),
      },
      'gauge',
    );
  }, 60_000);
  gauge.unref();

  app.addHook('onClose', async () => {
    clearInterval(gauge);
    sessionSync.stop();
    await sessionSync.flushAllDirty();
  });

  return app;
}
