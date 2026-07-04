// Zod schemas for inbound (client → server) messages.
//
// Server→client messages do not need schema validation: they're constructed by
// the server itself and the type system enforces shape. Only untrusted input
// from a socket needs runtime parsing.

import { z } from 'zod';

const VersionEnvelope = z.object({ v: z.literal(1) });

export const HelloSchema = VersionEnvelope.extend({
  type: z.literal('hello'),
  schemaVersion: z.number().int(),
  clientId: z.string().optional(),
  resumeFromOpId: z.number().int().nonnegative().optional(),
  token: z.string().optional(),
});

export const SetOpClientSchema = VersionEnvelope.extend({
  type: z.literal('set'),
  clientSeq: z.number().int().nonnegative(),
  path: z.array(z.union([z.string(), z.number().int()])),
  value: z.unknown(),
});

export const PongSchema = VersionEnvelope.extend({
  type: z.literal('pong'),
});

export const ResyncSchema = VersionEnvelope.extend({
  type: z.literal('resync'),
  fromOpId: z.number().int().nonnegative(),
});

export const LoadSchema = VersionEnvelope.extend({
  type: z.literal('load'),
  clientSeq: z.number().int().nonnegative(),
  project: z.unknown(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  SetOpClientSchema,
  PongSchema,
  ResyncSchema,
  LoadSchema,
]);
