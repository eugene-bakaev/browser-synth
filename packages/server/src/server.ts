import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { healthRoute } from './routes/health.js';
import { wsRoute } from './routes/ws.js';
import { InMemoryRoomStore } from './room/InMemoryRoomStore.js';
import { ConnectionPool } from './sync/ConnectionPool.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const store = new InMemoryRoomStore();
  const pool = new ConnectionPool();
  app.register(websocket);
  app.register(healthRoute);
  app.register(async (a) => wsRoute(a, { store, pool }));
  return app;
}
