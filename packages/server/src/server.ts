import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import postgres from 'postgres';
import { healthRoute } from './routes/health.js';
import { wsRoute } from './routes/ws.js';
import { InMemoryRoomStore } from './room/InMemoryRoomStore.js';
import { ConnectionPool } from './sync/ConnectionPool.js';
import { verifyToken, remoteJwks } from './auth/verifyToken.js';
import { InMemoryProfileStore } from './profile/InMemoryProfileStore.js';
import { PostgresProfileStore } from './profile/PostgresProfileStore.js';
import type { ProfileStore } from './profile/ProfileStore.js';
import type { VerifiedClaims } from './auth/verifyToken.js';

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

  const profiles: ProfileStore = dbUrl
    ? new PostgresProfileStore(postgres(dbUrl))
    : new InMemoryProfileStore();

  app.register(websocket);
  app.register(healthRoute);
  app.register(async (a) => wsRoute(a, { store, pool, verify, profiles }));
  return app;
}
