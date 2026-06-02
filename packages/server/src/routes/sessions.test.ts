import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { freshProject, DEFAULT_SESSION_SETTINGS } from '@fiddle/shared';
import { InMemorySessionStore } from '../session/InMemorySessionStore.js';
import { sessionsRoute } from './sessions.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import type { CreateSessionInput } from '../session/SessionStore.js';

const claimsByToken: Record<string, VerifiedClaims> = {
  'good-token': { userId: 'user-1', googleName: 'User One' },
  'other-token': { userId: 'user-2', googleName: 'User Two' },
};
const fakeVerify = async (t: string): Promise<VerifiedClaims | null> => claimsByToken[t] ?? null;

function build(
  sessions = new InMemorySessionStore(),
  counts = new Map<string, number>(),
) {
  const app = Fastify();
  app.register(async (a) =>
    sessionsRoute(a, { sessions, verify: fakeVerify, liveCounts: async () => counts }),
  );
  return { app, sessions };
}

function loggedIn(id: string, over: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id, name: 'A', description: 'd', ownerUserId: 'user-1', ownerClientId: null,
    settings: DEFAULT_SESSION_SETTINGS, project: freshProject(), ...over,
  };
}
function guest(id: string, clientId: string): CreateSessionInput {
  return {
    id, name: 'G', description: 'd', ownerUserId: null, ownerClientId: clientId,
    settings: DEFAULT_SESSION_SETTINGS, project: freshProject(),
  };
}

describe('sessions HTTP API', () => {
  it('POST creates a logged-in-owned session and returns an id', async () => {
    const { app, sessions } = build();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: 'Bearer good-token' },
      payload: { name: 'My Jam', description: 'groove' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const rec = await sessions.get(id);
    expect(rec?.ownerUserId).toBe('user-1');
    expect(rec?.ownerClientId).toBeNull();
    expect(rec?.name).toBe('My Jam');
    await app.close();
  });

  it('POST as a guest requires a clientId and records it', async () => {
    const { app, sessions } = build();
    const missing = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'g' } });
    expect(missing.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: 'g', clientId: 'client-9' } });
    expect(ok.statusCode).toBe(201);
    const { id } = ok.json() as { id: string };
    const rec = await sessions.get(id);
    expect(rec?.ownerUserId).toBeNull();
    expect(rec?.ownerClientId).toBe('client-9');
    await app.close();
  });

  it('POST rejects a malformed body', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST with seed=default seeds a fresh 4-track project', async () => {
    const { app, sessions } = build();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: 'Bearer good-token' },
      payload: { name: 'n', seed: 'default' },
    });
    const { id } = res.json() as { id: string };
    expect((await sessions.getSnapshot(id))?.tracks).toHaveLength(4);
    await app.close();
  });

  it('POST with an imported project seed stores it', async () => {
    const { app, sessions } = build();
    const project = freshProject();
    project.bpm = 137;
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { authorization: 'Bearer good-token' },
      payload: { name: 'n', seed: project },
    });
    const { id } = res.json() as { id: string };
    expect((await sessions.getSnapshot(id))?.bpm).toBe(137);
    await app.close();
  });

  it('GET lists logged-in sessions but hides empty guest sessions', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(loggedIn('a'));
    await sessions.create(guest('g', 'c1'));
    const { app } = build(sessions, new Map([['g', 0]]));
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: { id: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual(['a']);
    await app.close();
  });

  it('PATCH lets the logged-in owner edit; rejects a non-owner', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(loggedIn('a', { description: 'd' }));
    const { app } = build(sessions);
    const ok = await app.inject({
      method: 'PATCH', url: '/api/sessions/a',
      headers: { authorization: 'Bearer good-token' }, payload: { description: 'new' },
    });
    expect(ok.statusCode).toBe(204);
    expect((await sessions.get('a'))?.description).toBe('new');
    const denied = await app.inject({
      method: 'PATCH', url: '/api/sessions/a',
      headers: { authorization: 'Bearer other-token' }, payload: { description: 'x' },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('PATCH lets a guest owner edit by matching clientId', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(guest('g', 'c1'));
    const { app } = build(sessions);
    const ok = await app.inject({ method: 'PATCH', url: '/api/sessions/g', payload: { name: 'renamed', clientId: 'c1' } });
    expect(ok.statusCode).toBe(204);
    expect((await sessions.get('g'))?.name).toBe('renamed');
    const denied = await app.inject({ method: 'PATCH', url: '/api/sessions/g', payload: { name: 'x', clientId: 'wrong' } });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('PATCH returns 404 for an unknown session', async () => {
    const { app } = build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/sessions/none',
      headers: { authorization: 'Bearer good-token' }, payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE is allowed for the logged-in owner only', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(loggedIn('a'));
    const { app } = build(sessions);
    const denied = await app.inject({ method: 'DELETE', url: '/api/sessions/a', headers: { authorization: 'Bearer other-token' } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'DELETE', url: '/api/sessions/a', headers: { authorization: 'Bearer good-token' } });
    expect(ok.statusCode).toBe(204);
    expect(await sessions.get('a')).toBeNull();
    await app.close();
  });

  it('DELETE on a guest session is forbidden (no logged-in owner)', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.create(guest('g', 'c1'));
    const { app } = build(sessions);
    const res = await app.inject({ method: 'DELETE', url: '/api/sessions/g', headers: { authorization: 'Bearer good-token' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
