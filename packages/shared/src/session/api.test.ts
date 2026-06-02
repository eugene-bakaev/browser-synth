import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { freshProject } from '../project/index.js';
import { CreateSessionBodySchema, PatchSessionBodySchema, SessionSettingsSchema } from './api.js';
import type { SessionSettings } from './settings.js';

// Compile-time guard: the API validation schema and the SessionSettings type
// must not drift (the server consumes the type; the API validates with the schema).
type InferredSettings = z.infer<typeof SessionSettingsSchema>;
// Each line errors at compile time if the shapes diverge in either direction.
const _a: SessionSettings = {} as InferredSettings;
const _b: InferredSettings = {} as SessionSettings;
void _a; void _b;

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

  it('rejects a malformed seed object', () => {
    expect(CreateSessionBodySchema.safeParse({ name: 'n', seed: { schemaVersion: 1 } }).success).toBe(false);
  });

  it('rejects out-of-range settings (maxWritableUsers: 0)', () => {
    expect(CreateSessionBodySchema.safeParse({ name: 'n', settings: { maxWritableUsers: 0, tracksPerUser: 4 } }).success).toBe(false);
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
