import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CreatePresetBodySchema, PatchPresetBodySchema, randomBase32 } from '@fiddle/shared';
import type { EngineType } from '@fiddle/shared';
import type { PresetStore } from '../preset/PresetStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import { KeyedTokenBucket } from './rate-limit.js';

// Per-user create cap: a normal "save a few patches" flow never hits burst 10;
// a scripted loop does. Refill 1 / 10s.
export const PRESET_CREATE_BURST = 10;
export const PRESET_CREATE_REFILL_MS = 10_000;

interface Deps {
  presets: PresetStore;
  verify: (token: string) => Promise<VerifiedClaims | null>;
  createLimiter?: KeyedTokenBucket;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
}
async function claimsFrom(req: FastifyRequest, verify: Deps['verify']): Promise<VerifiedClaims | null> {
  const token = bearer(req);
  return token ? verify(token) : null;
}

export async function presetsRoute(app: FastifyInstance, deps: Deps) {
  const createLimiter = deps.createLimiter ?? new KeyedTokenBucket(PRESET_CREATE_BURST, PRESET_CREATE_REFILL_MS);

  // List: own + public, scoped to the (optional) viewer. Public read.
  app.get('/api/presets', async (req) => {
    const claims = await claimsFrom(req, deps.verify);
    const q = req.query as { engineType?: string };
    const engineType = q.engineType as EngineType | undefined;
    const rows = await deps.presets.list({ viewerUserId: claims?.userId ?? null, engineType });
    return { presets: rows };
  });

  // Create: login required.
  app.post('/api/presets', async (req, reply) => {
    const claims = await claimsFrom(req, deps.verify);
    if (!claims) return reply.code(401).send({ error: 'login required to save presets' });
    if (!createLimiter.consume(claims.userId)) {
      return reply.code(429).send({ error: 'too many presets created, try again shortly' });
    }
    const parsed = CreatePresetBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const id = randomBase32(9);
    await deps.presets.create({
      id,
      name: body.name,
      engineType: body.engineType,
      params: body.params,
      ownerUserId: claims.userId,
      isPublic: body.isPublic,
    });
    return reply.code(201).send({ id });
  });

  // Patch name / public flag: owner only.
  app.patch('/api/presets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchPresetBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    const record = await deps.presets.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });
    const claims = await claimsFrom(req, deps.verify);
    if (!claims || claims.userId !== record.ownerUserId) return reply.code(403).send({ error: 'not the owner' });
    await deps.presets.updateMeta(id, { name: parsed.data.name, isPublic: parsed.data.isPublic });
    return reply.code(204).send();
  });

  // Delete: owner only.
  app.delete('/api/presets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await deps.presets.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });
    const claims = await claimsFrom(req, deps.verify);
    if (!claims || claims.userId !== record.ownerUserId) return reply.code(403).send({ error: 'not the owner' });
    await deps.presets.delete(id);
    return reply.code(204).send();
  });
}
