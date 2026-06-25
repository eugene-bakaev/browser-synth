import { z } from 'zod';
import type { EngineType } from '../index.js';
import { Schemas } from '../project/schema.js';

// One source of truth mapping an engineType to its param schema. Reuses the
// per-engine schemas already used for sync-op validation.
const ENGINE_PARAM_SCHEMAS: Record<EngineType, z.ZodTypeAny> = {
  synth:  Schemas.SynthParams,
  synth2: Schemas.Synth2Params,
  kick:   Schemas.KickParams,
  kick2:  Schemas.Kick2Params,
  hat:    Schemas.HatParams,
  hat2:   Schemas.Hat2Params,
  snare:  Schemas.SnareParams,
  snare2: Schemas.Snare2Params,
  clap:   Schemas.ClapParams,
  clap2:  Schemas.Clap2Params,
};

export function presetParamsSchemaFor(engineType: EngineType): z.ZodTypeAny {
  return ENGINE_PARAM_SCHEMAS[engineType];
}

export const CreatePresetBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    engineType: Schemas.EngineType,
    params: z.unknown(),
    isPublic: z.boolean().optional().default(false),
  })
  .superRefine((val, ctx) => {
    const schema = ENGINE_PARAM_SCHEMAS[val.engineType as EngineType];
    if (!schema.safeParse(val.params).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['params'],
        message: 'params do not match the engineType schema',
      });
    }
  });

export type CreatePresetBody = z.infer<typeof CreatePresetBodySchema>;

export const PatchPresetBodySchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  isPublic: z.boolean().optional(),
});

export type PatchPresetBody = z.infer<typeof PatchPresetBodySchema>;

export interface PresetRecord {
  id: string;
  name: string;
  engineType: EngineType;
  params: unknown;
  ownerUserId: string;
  ownerUsername: string | null;
  isPublic: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
