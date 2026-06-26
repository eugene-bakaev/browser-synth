import { describe, it, expect } from 'vitest';
import {
  CreatePresetBodySchema,
  PatchPresetBodySchema,
  presetParamsSchemaFor,
} from './schema.js';
import { DEFAULT_KICK2_PARAMS } from '../engines/kick2.js';
import { DEFAULT_SYNTH_PARAMS } from '../engines/synth.js';

describe('preset contract', () => {
  it('accepts a valid kick2 preset body', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: '808 Boom',
      engineType: 'kick2',
      params: DEFAULT_KICK2_PARAMS,
      isPublic: true,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.isPublic).toBe(true);
  });

  it('defaults isPublic to false when omitted', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: 'My Patch', engineType: 'synth', params: DEFAULT_SYNTH_PARAMS,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.isPublic).toBe(false);
  });

  it('rejects an unknown engineType', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: 'x', engineType: 'tb303', params: {},
    });
    expect(res.success).toBe(false);
  });

  it('rejects params that do not match the engine schema', () => {
    const res = CreatePresetBodySchema.safeParse({
      name: 'x', engineType: 'kick2', params: { not: 'a kick2 patch' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an empty or over-long name', () => {
    expect(CreatePresetBodySchema.safeParse({ name: '', engineType: 'synth', params: DEFAULT_SYNTH_PARAMS }).success).toBe(false);
    expect(CreatePresetBodySchema.safeParse({ name: 'a'.repeat(61), engineType: 'synth', params: DEFAULT_SYNTH_PARAMS }).success).toBe(false);
  });

  it('presetParamsSchemaFor returns a schema for every engine', () => {
    const engines = ['synth','synth2','kick','kick2','hat','hat2','snare','snare2','clap','clap2'] as const;
    for (const e of engines) expect(presetParamsSchemaFor(e)).toBeDefined();
  });

  it('PatchPresetBodySchema accepts partial fields', () => {
    expect(PatchPresetBodySchema.safeParse({ name: 'renamed' }).success).toBe(true);
    expect(PatchPresetBodySchema.safeParse({ isPublic: true }).success).toBe(true);
    expect(PatchPresetBodySchema.safeParse({}).success).toBe(true);
  });
});
