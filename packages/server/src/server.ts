import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { healthRoute } from './routes/health.js';
import { wsRoute } from './routes/ws.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.register(websocket);
  app.register(healthRoute);
  app.register(wsRoute);
  return app;
}
