import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { DEFAULT_KICK2_PARAMS } from '@fiddle/shared'; // confirm exact export name in shared engines barrel
import { InMemoryPresetStore } from '../preset/InMemoryPresetStore.js';
import { presetsRoute } from './presets.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';

const claimsByToken: Record<string, VerifiedClaims> = {
  'tok-1': { userId: 'user-1', googleName: 'User One' },
  'tok-2': { userId: 'user-2', googleName: 'User Two' },
};
const fakeVerify = async (t: string): Promise<VerifiedClaims | null> => claimsByToken[t] ?? null;

function build(presets = new InMemoryPresetStore()) {
  const app = Fastify();
  app.register(async (a) => presetsRoute(a, { presets, verify: fakeVerify }));
  return { app, presets };
}

const validBody = { name: 'Boom', engineType: 'kick2', params: DEFAULT_KICK2_PARAMS, isPublic: false };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('presets HTTP API', () => {
  it('POST requires login (401 for guests)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/api/presets', payload: validBody });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('POST creates a preset owned by the caller', async () => {
    const { app, presets } = build();
    const res = await app.inject({ method: 'POST', url: '/api/presets', headers: auth('tok-1'), payload: validBody });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    expect((await presets.get(id))?.ownerUserId).toBe('user-1');
    await app.close();
  });

  it('POST rejects an invalid body (400)', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/api/presets', headers: auth('tok-1'),
      payload: { name: '', engineType: 'kick2', params: {} } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('GET returns own + public, scoped to the viewer', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'a', name: 'mine', engineType: 'kick2', params: {}, ownerUserId: 'user-1', isPublic: false });
    await presets.create({ id: 'b', name: 'pub',  engineType: 'kick2', params: {}, ownerUserId: 'user-2', isPublic: true });
    await presets.create({ id: 'c', name: 'hidden', engineType: 'kick2', params: {}, ownerUserId: 'user-2', isPublic: false });

    const asUser1 = await app.inject({ method: 'GET', url: '/api/presets', headers: auth('tok-1') });
    expect(((asUser1.json() as { presets: { id: string }[] }).presets).map((p) => p.id).sort()).toEqual(['a', 'b']);

    const asGuest = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(((asGuest.json() as { presets: { id: string }[] }).presets).map((p) => p.id)).toEqual(['b']);
    await app.close();
  });

  it('GET filters by engineType', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'k', name: 'k', engineType: 'kick2', params: {}, ownerUserId: 'user-2', isPublic: true });
    await presets.create({ id: 'h', name: 'h', engineType: 'hat2',  params: {}, ownerUserId: 'user-2', isPublic: true });
    const res = await app.inject({ method: 'GET', url: '/api/presets?engineType=hat2' });
    expect(((res.json() as { presets: { id: string }[] }).presets).map((p) => p.id)).toEqual(['h']);
    await app.close();
  });

  it('PATCH/DELETE are owner-only', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'p', name: 'x', engineType: 'kick2', params: {}, ownerUserId: 'user-1', isPublic: false });

    const notOwner = await app.inject({ method: 'PATCH', url: '/api/presets/p', headers: auth('tok-2'), payload: { isPublic: true } });
    expect(notOwner.statusCode).toBe(403);

    const owner = await app.inject({ method: 'PATCH', url: '/api/presets/p', headers: auth('tok-1'), payload: { isPublic: true } });
    expect(owner.statusCode).toBe(204);
    expect((await presets.get('p'))?.isPublic).toBe(true);

    const delNotOwner = await app.inject({ method: 'DELETE', url: '/api/presets/p', headers: auth('tok-2') });
    expect(delNotOwner.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/api/presets/p', headers: auth('tok-1') });
    expect(del.statusCode).toBe(204);
    expect(await presets.get('p')).toBeNull();
    await app.close();
  });

  it('PATCH/DELETE on a missing preset → 404', async () => {
    const { app } = build();
    const patch = await app.inject({ method: 'PATCH', url: '/api/presets/nope', headers: auth('tok-1'), payload: { name: 'y' } });
    expect(patch.statusCode).toBe(404);
    await app.close();
  });

  it('unauthenticated PATCH → 401', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'p', name: 'x', engineType: 'kick2', params: {}, ownerUserId: 'user-1', isPublic: false });
    const res = await app.inject({ method: 'PATCH', url: '/api/presets/p', payload: { isPublic: true } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('unauthenticated DELETE → 401', async () => {
    const { app, presets } = build();
    await presets.create({ id: 'p', name: 'x', engineType: 'kick2', params: {}, ownerUserId: 'user-1', isPublic: false });
    const res = await app.inject({ method: 'DELETE', url: '/api/presets/p' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('DELETE on a missing preset (authenticated) → 404', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'DELETE', url: '/api/presets/nope', headers: auth('tok-1') });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
