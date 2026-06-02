import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { InMemorySessionStore } from '../session/InMemorySessionStore.js';
import { sessionsRoute } from './sessions.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';

const fakeVerify = async (): Promise<VerifiedClaims | null> => null;

function build(sessions = new InMemorySessionStore()) {
  const app = Fastify();
  app.register(async (a) =>
    sessionsRoute(a, { sessions, verify: fakeVerify, liveCounts: () => Promise.resolve(new Map()) }),
  );
  return { app, sessions };
}

describe('GET /api/sessions/:id', () => {
  it('returns the record (metadata + owner fields, no project) for a known id', async () => {
    const { app, sessions } = build();
    await sessions.create({
      id: 'abc', name: 'Jam', description: 'd', ownerUserId: null, ownerClientId: 'c1',
      settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
    });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/abc' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'abc', name: 'Jam', description: 'd',
      ownerUserId: null, ownerClientId: 'c1', isGuestOwned: true,
    });
    expect(body.settings).toEqual(DEFAULT_SESSION_SETTINGS);
    expect(body.project).toBeUndefined();
    await app.close();
  });

  it('returns 404 for an unknown id', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
