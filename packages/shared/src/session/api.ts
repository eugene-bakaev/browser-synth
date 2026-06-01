import { z } from 'zod';
import { ProjectSchema } from '../project/schema.js';

// Request bodies for the /api/sessions HTTP API. Shared so the client (Plan 3)
// and server validate against one source of truth.

export const SessionSettingsSchema = z.object({
  maxWritableUsers: z.number().int().min(1).max(16),
  tracksPerUser: z.number().int().min(1).max(16),
});

export const CreateSessionBodySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  settings: SessionSettingsSchema.optional(),
  // 'default' seeds a blank project; a full project object imports it (e.g. from
  // the existing export-to-JSON). Validated against the project schema.
  seed: z.union([z.literal('default'), ProjectSchema]).default('default'),
  // Required for guest creators (matched later to authorise settings edits while
  // the session is live). Ignored for logged-in creators.
  clientId: z.string().min(1).optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const PatchSessionBodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  settings: SessionSettingsSchema.optional(),
  // Guest owners pass their clientId to authorise the edit.
  clientId: z.string().min(1).optional(),
});
export type PatchSessionBody = z.infer<typeof PatchSessionBodySchema>;
