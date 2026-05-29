import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';

describe('server', () => {
  it('serves /health', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('registers GET /ws/:roomId', async () => {
    // @fastify/websocket replaces the HTTP handler for ws routes so a non-upgrade
    // request will get a 404 from the plugin itself — that's indistinguishable
    // from an unregistered route via response status. Use printRoutes to confirm
    // the route is in the router. Exercising the actual handshake requires the
    // HTTP server to be listening, which is too heavy for a unit test.
    const app = buildServer();
    await app.ready();
    const routes = app.printRoutes({ includeHooks: false, includeMeta: false });
    expect(routes).toContain('ws/');
    expect(routes).toContain(':roomId');
    await app.close();
  });
});
