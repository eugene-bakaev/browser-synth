// Local Supabase JWT verification. The key resolver is injected: production
// passes a cached remote JWKS (createRemoteJWKSet), tests pass a public key.
// Verification is offline — no network call on the hello hot path beyond the
// JWKS key fetch, which jose caches.
//
// Note: jose v6 dropped the legacy KeyLike alias. Key types are CryptoKey,
// KeyObject, JWK, Uint8Array, or JWTVerifyGetKey (for JWKS).

import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { CryptoKey } from 'jose';

export interface VerifiedClaims {
  userId: string;
  googleName: string;
}

type KeyInput = CryptoKey | Uint8Array | JWTVerifyGetKey;

export async function verifyToken(token: string, key: KeyInput): Promise<VerifiedClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1]);
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) return null;
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const name = typeof meta.name === 'string' && meta.name ? meta.name : null;
    const fullName = typeof meta.full_name === 'string' && meta.full_name ? meta.full_name : null;
    return { userId: sub, googleName: name ?? fullName ?? 'Player' };
  } catch (err) {
    // Expected verification failures (bad signature, expired, malformed, …) all
    // carry a JWT*/JWS* error name — the token is simply invalid, return null
    // quietly. Anything else (e.g. an unreachable or misconfigured JWKS URL)
    // means every authenticated user would be silently downgraded to a guest;
    // surface that so it's diagnosable rather than invisible.
    const name = err instanceof Error ? err.name : '';
    if (!name.startsWith('JWT') && !name.startsWith('JWS')) {
      console.error('[verifyToken] unexpected verification error (possible misconfiguration):', err);
    }
    return null;
  }
}

// Production key resolver: a cached remote JWKS for the Supabase project.
// jose caches keys and refreshes on rotation, so this is created once at boot.
export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl));
}
