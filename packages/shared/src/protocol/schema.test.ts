import { describe, it, expect } from 'vitest';
import { ClientMessageSchema, HelloSchema } from './schema.js';

describe('ClientMessageSchema', () => {
  it('accepts a fresh hello', () => {
    expect(
      ClientMessageSchema.safeParse({ v: 1, type: 'hello', schemaVersion: 1 }).success,
    ).toBe(true);
  });

  it('accepts a resume hello', () => {
    const r = ClientMessageSchema.safeParse({
      v: 1,
      type: 'hello',
      schemaVersion: 1,
      clientId: 'c_a3f9',
      resumeFromOpId: 42,
    });
    expect(r.success).toBe(true);
  });

  it('rejects hello with wrong v', () => {
    expect(
      ClientMessageSchema.safeParse({ v: 2, type: 'hello', schemaVersion: 1 }).success,
    ).toBe(false);
  });

  it('accepts a set op', () => {
    expect(
      ClientMessageSchema.safeParse({
        v: 1,
        type: 'set',
        clientSeq: 17,
        path: ['bpm'],
        value: 120,
      }).success,
    ).toBe(true);
  });

  it('rejects set op with negative clientSeq', () => {
    expect(
      ClientMessageSchema.safeParse({
        v: 1,
        type: 'set',
        clientSeq: -1,
        path: ['bpm'],
        value: 120,
      }).success,
    ).toBe(false);
  });

  it('accepts pong', () => {
    expect(ClientMessageSchema.safeParse({ v: 1, type: 'pong' }).success).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(
      ClientMessageSchema.safeParse({ v: 1, type: 'gibberish' }).success,
    ).toBe(false);
  });
});

describe('HelloSchema token field', () => {
  it('accepts a hello with a token', () => {
    const r = HelloSchema.safeParse({ v: 1, type: 'hello', schemaVersion: 2, token: 'jwt.abc.def' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.token).toBe('jwt.abc.def');
  });

  it('accepts a hello without a token (guest)', () => {
    const r = HelloSchema.safeParse({ v: 1, type: 'hello', schemaVersion: 2 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.token).toBeUndefined();
  });

  it('rejects a non-string token', () => {
    const r = HelloSchema.safeParse({ v: 1, type: 'hello', schemaVersion: 2, token: 123 });
    expect(r.success).toBe(false);
  });
});
