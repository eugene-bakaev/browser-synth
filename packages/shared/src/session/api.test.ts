import { describe, it, expect } from 'vitest';
import { freshProject } from '../project/index.js';
import { CreateSessionBodySchema, PatchSessionBodySchema } from './api.js';

describe('CreateSessionBodySchema', () => {
  it('defaults description to "" and seed to "default"', () => {
    const parsed = CreateSessionBodySchema.parse({ name: 'My Jam' });
    expect(parsed.description).toBe('');
    expect(parsed.seed).toBe('default');
  });

  it('rejects an empty name', () => {
    expect(CreateSessionBodySchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('accepts a full project as the seed', () => {
    const parsed = CreateSessionBodySchema.parse({ name: 'n', seed: freshProject() });
    expect(parsed.seed).not.toBe('default');
    expect(typeof parsed.seed === 'object' && parsed.seed.tracks).toHaveLength(4);
  });

  it('accepts optional settings and clientId', () => {
    const parsed = CreateSessionBodySchema.parse({
      name: 'n', clientId: 'c1', settings: { maxWritableUsers: 4, tracksPerUser: 4 },
    });
    expect(parsed.clientId).toBe('c1');
    expect(parsed.settings).toEqual({ maxWritableUsers: 4, tracksPerUser: 4 });
  });
});

describe('PatchSessionBodySchema', () => {
  it('allows a subset of fields', () => {
    const parsed = PatchSessionBodySchema.parse({ description: 'new' });
    expect(parsed.description).toBe('new');
    expect(parsed.name).toBeUndefined();
  });

  it('rejects an empty name when name is provided', () => {
    expect(PatchSessionBodySchema.safeParse({ name: '' }).success).toBe(false);
  });
});
