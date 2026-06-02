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

  it('boots with no Supabase env (guest-only) and serves /health', async () => {
    const { SUPABASE_JWKS_URL, DATABASE_URL } = process.env;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.DATABASE_URL;
    try {
      const app = buildServer();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      await app.close();
    } finally {
      if (SUPABASE_JWKS_URL !== undefined) process.env.SUPABASE_JWKS_URL = SUPABASE_JWKS_URL;
      if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;
    }
  });

  it('GET /api/sessions returns a sessions array', async () => {
    const { SUPABASE_JWKS_URL, DATABASE_URL } = process.env;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.DATABASE_URL;
    try {
      const app = buildServer();
      const res = await app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray((res.json() as { sessions: unknown[] }).sessions)).toBe(true);
      await app.close();
    } finally {
      if (SUPABASE_JWKS_URL !== undefined) process.env.SUPABASE_JWKS_URL = SUPABASE_JWKS_URL;
      if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;
    }
  });

  it('sets Access-Control-Allow-Origin on /api responses (cross-origin prod)', async () => {
    const { SUPABASE_JWKS_URL, DATABASE_URL, CORS_ORIGIN } = process.env;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CORS_ORIGIN;
    try {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { origin: 'https://fiddle-client.vercel.app' },
      });
      expect(res.headers['access-control-allow-origin']).toBe('https://fiddle-client.vercel.app');
      await app.close();
    } finally {
      if (SUPABASE_JWKS_URL !== undefined) process.env.SUPABASE_JWKS_URL = SUPABASE_JWKS_URL;
      if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;
      if (CORS_ORIGIN !== undefined) process.env.CORS_ORIGIN = CORS_ORIGIN;
    }
  });

  it('POST /api/sessions creates a guest session (clientId required)', async () => {
    const { SUPABASE_JWKS_URL, DATABASE_URL } = process.env;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.DATABASE_URL;
    try {
      const app = buildServer();
      // Guest-only (no JWKS) → verify() returns null → guest path.
      const noClient = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'jam' } });
      expect(noClient.statusCode).toBe(400);
      const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'jam', clientId: 'c1' } });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { id: string }).id).toHaveLength(9);
      await app.close();
    } finally {
      if (SUPABASE_JWKS_URL !== undefined) process.env.SUPABASE_JWKS_URL = SUPABASE_JWKS_URL;
      if (DATABASE_URL !== undefined) process.env.DATABASE_URL = DATABASE_URL;
    }
  });
});
