import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { verifyToken } from './verifyToken.js';

// jose v6 uses CryptoKey in place of the legacy KeyLike type.
let priv: CryptoKey;
let pub: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair('ES256');
  priv = kp.privateKey as CryptoKey;
  pub = kp.publicKey as CryptoKey;
});

async function sign(payload: Record<string, unknown>, expSeconds = 3600): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
    .sign(priv);
}

describe('verifyToken', () => {
  it('returns userId + googleName for a valid token', async () => {
    const token = await sign({ sub: 'user-123', user_metadata: { name: 'Eugene B' } });
    const claims = await verifyToken(token, pub);
    expect(claims).toEqual({ userId: 'user-123', googleName: 'Eugene B' });
  });

  it('falls back to full_name, then a default, for the google name', async () => {
    const a = await verifyToken(await sign({ sub: 'u1', user_metadata: { full_name: 'Full Name' } }), pub);
    expect(a?.googleName).toBe('Full Name');
    const b = await verifyToken(await sign({ sub: 'u2', user_metadata: {} }), pub);
    expect(b?.googleName).toBe('Player');
  });

  it('returns null for an expired token', async () => {
    const token = await sign({ sub: 'user-123', user_metadata: { name: 'X' } }, -10);
    expect(await verifyToken(token, pub)).toBeNull();
  });

  it('returns null for a wrong-signature token', async () => {
    const otherKp = await generateKeyPair('ES256');
    const token = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherKp.privateKey);
    expect(await verifyToken(token, pub)).toBeNull();
  });

  it('returns null for a malformed token', async () => {
    expect(await verifyToken('not-a-jwt', pub)).toBeNull();
  });

  it('returns null when sub is missing', async () => {
    const token = await sign({ user_metadata: { name: 'X' } });
    expect(await verifyToken(token, pub)).toBeNull();
  });
});
