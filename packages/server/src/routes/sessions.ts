import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateSessionBodySchema,
  PatchSessionBodySchema,
  DEFAULT_SESSION_SETTINGS,
  freshProject,
  randomBase32,
} from '@fiddle/shared';
import type { Project } from '@fiddle/shared';
import type { SessionStore } from '../session/SessionStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import { buildLobbyList } from '../session/lobby.js';

interface Deps {
  sessions: SessionStore;
  verify: (token: string) => Promise<VerifiedClaims | null>;
  // Live member counts per room, injected so the route stays decoupled from the
  // RoomStore type (buildServer passes () => roomStore.roomMemberCounts()).
  liveCounts: () => Promise<Map<string, number>>;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

async function claimsFrom(req: FastifyRequest, verify: Deps['verify']): Promise<VerifiedClaims | null> {
  const token = bearer(req);
  return token ? verify(token) : null;
}

export async function sessionsRoute(app: FastifyInstance, deps: Deps) {
  // List: durable sessions merged with live presence. Public, no auth.
  app.get('/api/sessions', async () => {
    const [records, counts] = await Promise.all([deps.sessions.list(), deps.liveCounts()]);
    return { sessions: buildLobbyList(records, counts) };
  });

  // Single session metadata (no project blob). Public; powers the studio's
  // session-settings panel + deep-link ownership checks.
  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await deps.sessions.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      ownerUserId: record.ownerUserId,
      ownerClientId: record.ownerClientId,
      isGuestOwned: record.ownerUserId === null,
      settings: record.settings,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  });

  // Create. Bearer JWT → logged-in owner; otherwise guest (needs clientId).
  app.post('/api/sessions', async (req, reply) => {
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const claims = await claimsFrom(req, deps.verify);

    let ownerUserId: string | null = null;
    let ownerClientId: string | null = null;
    if (claims) {
      ownerUserId = claims.userId;
    } else {
      if (!body.clientId) {
        return reply.code(400).send({ error: 'guest sessions require clientId' });
      }
      ownerClientId = body.clientId;
    }

    // seed is either the literal 'default' or a schema-validated project.
    const project: Project = body.seed === 'default' ? freshProject() : (body.seed as Project);
    const id = randomBase32(9);
    await deps.sessions.create({
      id,
      name: body.name,
      description: body.description,
      ownerUserId,
      ownerClientId,
      settings: body.settings ?? DEFAULT_SESSION_SETTINGS,
      project,
    });
    return reply.code(201).send({ id });
  });

  // Patch name/description/settings. Owner = matching userId (logged-in) OR
  // matching ownerClientId (guest, weak — strengthened in the moderation spec).
  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchSessionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const record = await deps.sessions.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });

    const claims = await claimsFrom(req, deps.verify);
    const isOwner =
      (claims !== null && record.ownerUserId !== null && claims.userId === record.ownerUserId) ||
      (record.ownerClientId !== null && parsed.data.clientId === record.ownerClientId);
    if (!isOwner) return reply.code(403).send({ error: 'not the owner' });

    await deps.sessions.updateMeta(id, {
      name: parsed.data.name,
      description: parsed.data.description,
      settings: parsed.data.settings,
    });
    return reply.code(204).send();
  });

  // Delete: logged-in owner only. Guest sessions self-prune on empty (SessionSync).
  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await deps.sessions.get(id);
    if (!record) return reply.code(404).send({ error: 'not found' });

    const claims = await claimsFrom(req, deps.verify);
    const isOwner = claims !== null && record.ownerUserId !== null && claims.userId === record.ownerUserId;
    if (!isOwner) return reply.code(403).send({ error: 'not the owner' });

    await deps.sessions.delete(id);
    return reply.code(204).send();
  });
}
