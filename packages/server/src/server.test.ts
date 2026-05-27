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
});
