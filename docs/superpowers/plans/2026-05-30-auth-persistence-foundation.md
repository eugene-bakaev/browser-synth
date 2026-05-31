# Auth + Persistence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional Google sign-in (Supabase) with a JWT verified on the WebSocket hello frame, stand up the server's Postgres access layer, and add a `profiles` table with a claimable unique username — guests keep today's anonymous flow.

**Architecture:** The browser talks directly to Supabase for login and profile CRUD (RLS-guarded). On WS hello it sends the Supabase access token; the Fastify server verifies the JWT signature locally (cached JWKS, no network call), reads `profiles.username` for that user via a privileged Postgres connection, and resolves the room handle. `clientId` stays per-connection-unique; `userId` rides alongside it on `Identity`. Login/logout triggers a WS reconnect so identity is re-derived. Everything degrades gracefully to guest-only when Supabase env vars are absent.

**Tech Stack:** Vue 3 + TypeScript + Vite (client), Fastify 5 + `@fastify/websocket` (server), Zod (wire validation), `@supabase/supabase-js` (client auth/profile), `jose` (server JWT verify), `postgres` (server DB), Supabase (Auth + Postgres + RLS).

**Spec:** `docs/superpowers/specs/2026-05-30-auth-persistence-foundation-design.md`

---

## File Structure

**Shared (`packages/shared/src`):**
- `protocol/types.ts` — MODIFY: `Identity` gains optional `userId`/`authenticated`; `HelloMessage` gains optional `token`; `ErrorCode` gains `'auth.invalid'`.
- `protocol/identity.ts` — MODIFY: widen `Handle` to `string`.
- `protocol/schema.ts` — MODIFY: `HelloSchema` gains optional `token`.

**Server (`packages/server/src`):**
- `auth/verifyToken.ts` — CREATE: local JWT verification → `{ userId, googleName } | null`.
- `profile/ProfileStore.ts` — CREATE: `ProfileStore` interface.
- `profile/InMemoryProfileStore.ts` — CREATE: test/fallback fake.
- `profile/PostgresProfileStore.ts` — CREATE: production `SELECT username`.
- `room/identity.ts` — MODIFY: add `makeAuthenticatedIdentity`; set new fields in `makeIdentity`.
- `sync/ConnectionHandler.ts` — MODIFY: constructor takes a verify fn + `ProfileStore`; `handleHello` token branch.
- `server.ts` — MODIFY: build verify fn + profile store from env, inject.
- `routes/ws.ts` — MODIFY: thread the two new deps through.

**Client (`packages/client/src`):**
- `auth/supabase.ts` — CREATE: Supabase client singleton (or `null` if unconfigured).
- `auth/useAuth.ts` — CREATE: session/username state + `signInWithGoogle`/`signOut`/`setUsername`.
- `sync/WsClient.ts` — MODIFY: `getToken` option + token in hello + `reconnect()`.
- `composables/useSynth.ts` — MODIFY: pass `getToken`, reconnect on auth change.
- `components/RoomBar.vue` — MODIFY: login button + username editor.

**Config / migration / docs:**
- `supabase/migrations/0001_profiles.sql` — CREATE.
- `render.yaml` — MODIFY: add `SUPABASE_JWKS_URL`, `DATABASE_URL` env vars.
- `.env.example` — CREATE: documented vars for client + server.
- `.gitignore` — MODIFY: ignore `.env`.
- `docs/ARCHITECTURE.md` — MODIFY: new section + decision entry.

**Gate (run before every commit):** `npm run typecheck && npm test && npm run build` — all green.

---

## Task 1: Shared wire-protocol changes (token, richer Identity, Handle, error code)

**Files:**
- Modify: `packages/shared/src/protocol/types.ts`
- Modify: `packages/shared/src/protocol/identity.ts`
- Modify: `packages/shared/src/protocol/schema.ts`
- Test: `packages/shared/src/protocol/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/protocol/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { HelloSchema } from './schema';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/shared -- schema`
Expected: FAIL — the `token: 123` case currently passes (unknown key stripped), or the `token` field is absent from `r.data`.

- [ ] **Step 3: Add the token field to HelloSchema**

In `packages/shared/src/protocol/schema.ts`, add `token` to `HelloSchema`:

```ts
export const HelloSchema = VersionEnvelope.extend({
  type: z.literal('hello'),
  schemaVersion: z.number().int(),
  clientId: z.string().optional(),
  resumeFromOpId: z.number().int().nonnegative().optional(),
  token: z.string().optional(),
});
```

- [ ] **Step 4: Widen Handle and extend the protocol types**

In `packages/shared/src/protocol/identity.ts`, change the `Handle` type (keep the `HANDLES` array exactly as-is):

```ts
// Custom usernames (authenticated users) can be any string; guest handles are
// still drawn from HANDLES below. The type is open so an account-supplied name
// is assignable to Identity.handle.
export type Handle = string;
```

In `packages/shared/src/protocol/types.ts`, update `Identity`, `HelloMessage`, and `ErrorCode`:

```ts
export interface Identity {
  clientId: string;
  color: PaletteColor;
  handle: Handle;
  // Present for authenticated (Google) users; absent/false for guests. clientId
  // stays per-connection-unique — userId is the stable account id carried
  // alongside it (the hook for future per-user features).
  userId?: string | null;
  authenticated?: boolean;
}
```

```ts
export interface HelloMessage {
  v: 1;
  type: 'hello';
  schemaVersion: number;
  clientId?: string;       // present on resume
  resumeFromOpId?: number; // present on resume
  token?: string;          // present when the user is logged in (Supabase JWT)
}
```

```ts
export type ErrorCode =
  | 'schema.version_mismatch'
  | 'protocol.version_mismatch'
  | 'hello.invalid'
  | 'auth.invalid'
  | 'room.full'
  | 'resume.unknown_client'
  | 'resume.client_ahead'
  | 'overloaded'
  | 'internal';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @fiddle/shared -- schema`
Expected: PASS (all three new cases green).

- [ ] **Step 6: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (the `Handle = string` widening removes no behavior; existing `Identity` literals stay valid because the new fields are optional).

```bash
git add packages/shared/src/protocol/types.ts packages/shared/src/protocol/identity.ts packages/shared/src/protocol/schema.ts packages/shared/src/protocol/schema.test.ts
git commit -m "feat(shared): hello token, userId/authenticated on Identity, auth.invalid

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Server JWT verification (`verifyToken`)

**Files:**
- Create: `packages/server/src/auth/verifyToken.ts`
- Test: `packages/server/src/auth/verifyToken.test.ts`
- Modify: `packages/server/package.json` (add `jose`)

- [ ] **Step 1: Add the `jose` dependency**

Run: `npm install -w @fiddle/server jose`
Expected: `jose` appears under `packages/server/package.json` dependencies. (npm only — do NOT touch any pnpm lockfile.)

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/auth/verifyToken.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair, type KeyLike } from 'jose';
import { verifyToken } from './verifyToken.js';

let priv: KeyLike;
let pub: KeyLike;

beforeAll(async () => {
  const kp = await generateKeyPair('ES256');
  priv = kp.privateKey;
  pub = kp.publicKey;
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @fiddle/server -- verifyToken`
Expected: FAIL — `verifyToken` does not exist.

- [ ] **Step 4: Implement `verifyToken`**

Create `packages/server/src/auth/verifyToken.ts`:

```ts
// Local Supabase JWT verification. The key resolver is injected: production
// passes a cached remote JWKS (createRemoteJWKSet), tests pass a public key.
// Verification is offline — no network call on the hello hot path beyond the
// JWKS key fetch, which jose caches.

import { jwtVerify, createRemoteJWKSet, type KeyLike, type JWTVerifyGetKey } from 'jose';

export interface VerifiedClaims {
  userId: string;
  googleName: string;
}

type KeyInput = KeyLike | Uint8Array | JWTVerifyGetKey;

export async function verifyToken(token: string, key: KeyInput): Promise<VerifiedClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1]);
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) return null;
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const name = typeof meta.name === 'string' && meta.name ? meta.name : null;
    const fullName = typeof meta.full_name === 'string' && meta.full_name ? meta.full_name : null;
    return { userId: sub, googleName: name ?? fullName ?? 'Player' };
  } catch {
    return null;
  }
}

// Production key resolver: a cached remote JWKS for the Supabase project.
// jose caches keys and refreshes on rotation, so this is created once at boot.
export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @fiddle/server -- verifyToken`
Expected: PASS (all six cases).

- [ ] **Step 6: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

```bash
git add packages/server/src/auth/verifyToken.ts packages/server/src/auth/verifyToken.test.ts packages/server/package.json package-lock.json
git commit -m "feat(server): local Supabase JWT verification via jose

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `ProfileStore` interface + in-memory fake

**Files:**
- Create: `packages/server/src/profile/ProfileStore.ts`
- Create: `packages/server/src/profile/InMemoryProfileStore.ts`
- Test: `packages/server/src/profile/InMemoryProfileStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/profile/InMemoryProfileStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryProfileStore } from './InMemoryProfileStore.js';

describe('InMemoryProfileStore', () => {
  it('returns null for an unknown user', async () => {
    const store = new InMemoryProfileStore();
    expect(await store.getUsername('nobody')).toBeNull();
  });

  it('returns a seeded username', async () => {
    const store = new InMemoryProfileStore({ 'user-1': 'DJ Eugene' });
    expect(await store.getUsername('user-1')).toBe('DJ Eugene');
  });

  it('set() then get() round-trips', async () => {
    const store = new InMemoryProfileStore();
    store.set('user-2', 'Beatmaker');
    expect(await store.getUsername('user-2')).toBe('Beatmaker');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/server -- InMemoryProfileStore`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the interface + fake**

Create `packages/server/src/profile/ProfileStore.ts`:

```ts
// ProfileStore — read surface for per-user profile data the realtime server
// needs (just the username today). Async so the Postgres implementation can
// drop in without touching ConnectionHandler. Mirrors the RoomStore pattern.

export interface ProfileStore {
  // The user's chosen username, or null if unset / unknown. The server falls
  // back to the Google display name from the JWT when this is null.
  getUsername(userId: string): Promise<string | null>;
}
```

Create `packages/server/src/profile/InMemoryProfileStore.ts`:

```ts
import type { ProfileStore } from './ProfileStore.js';

// In-memory ProfileStore for unit tests and the no-database fallback path.
export class InMemoryProfileStore implements ProfileStore {
  private readonly usernames = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [id, name] of Object.entries(seed)) this.usernames.set(id, name);
  }

  async getUsername(userId: string): Promise<string | null> {
    return this.usernames.get(userId) ?? null;
  }

  set(userId: string, username: string): void {
    this.usernames.set(userId, username);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fiddle/server -- InMemoryProfileStore`
Expected: PASS.

- [ ] **Step 5: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

```bash
git add packages/server/src/profile/ProfileStore.ts packages/server/src/profile/InMemoryProfileStore.ts packages/server/src/profile/InMemoryProfileStore.test.ts
git commit -m "feat(server): ProfileStore interface + in-memory fake

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `PostgresProfileStore`

**Files:**
- Create: `packages/server/src/profile/PostgresProfileStore.ts`
- Test: `packages/server/src/profile/PostgresProfileStore.test.ts`
- Modify: `packages/server/package.json` (add `postgres`)

- [ ] **Step 1: Add the `postgres` dependency**

Run: `npm install -w @fiddle/server postgres`
Expected: `postgres` appears under `packages/server/package.json` dependencies.

- [ ] **Step 2: Write the failing test (env-guarded integration)**

Create `packages/server/src/profile/PostgresProfileStore.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { PostgresProfileStore } from './PostgresProfileStore.js';

// Integration test: only runs when TEST_DATABASE_URL points at a throwaway
// Postgres. Skipped in the default unit run (the in-memory fake covers logic).
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresProfileStore (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: PostgresProfileStore;

  beforeAll(async () => {
    sql = postgres(url!);
    await sql`create table if not exists profiles (id text primary key, username text unique)`;
    await sql`insert into profiles (id, username) values ('u-known', 'Known') on conflict (id) do nothing`;
    store = new PostgresProfileStore(sql);
  });

  afterAll(async () => {
    await sql`drop table if exists profiles`;
    await sql.end();
  });

  it('returns the username for an existing row', async () => {
    expect(await store.getUsername('u-known')).toBe('Known');
  });

  it('returns null for a missing row', async () => {
    expect(await store.getUsername('u-absent')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it is skipped (no DB) or fails (DB set)**

Run: `npm test -w @fiddle/server -- PostgresProfileStore`
Expected: SKIPPED when `TEST_DATABASE_URL` is unset (the common case). If a dev exports `TEST_DATABASE_URL`, expect FAIL — module not implemented yet.

- [ ] **Step 4: Implement `PostgresProfileStore`**

Create `packages/server/src/profile/PostgresProfileStore.ts`:

```ts
import postgres from 'postgres';
import type { ProfileStore } from './ProfileStore.js';

// The connected-client type postgres() returns (the package doesn't export a
// clean named `Sql` type across versions, so derive it from the constructor).
type Sql = ReturnType<typeof postgres>;

// Reads profiles via a privileged Postgres connection (not the anon key), so
// RLS — which guards only the browser's direct access — does not apply here.
// One indexed primary-key lookup per hello.
export class PostgresProfileStore implements ProfileStore {
  constructor(private readonly sql: Sql) {}

  async getUsername(userId: string): Promise<string | null> {
    const rows = await this.sql<{ username: string | null }[]>`
      select username from profiles where id = ${userId} limit 1
    `;
    return rows[0]?.username ?? null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes (or stays skipped)**

Run: `npm test -w @fiddle/server -- PostgresProfileStore`
Expected: PASS when `TEST_DATABASE_URL` is set; SKIPPED otherwise. Either is acceptable.

- [ ] **Step 6: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (the integration test is skipped in CI without a DB).

```bash
git add packages/server/src/profile/PostgresProfileStore.ts packages/server/src/profile/PostgresProfileStore.test.ts packages/server/package.json package-lock.json
git commit -m "feat(server): PostgresProfileStore (privileged username read)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `makeAuthenticatedIdentity`

**Files:**
- Modify: `packages/server/src/room/identity.ts`
- Test: `packages/server/src/room/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/room/identity.test.ts`:

```ts
import { makeAuthenticatedIdentity } from './identity';

describe('makeAuthenticatedIdentity', () => {
  it('uses the supplied handle + userId and marks authenticated', () => {
    const id = makeAuthenticatedIdentity([], { userId: 'user-9', handle: 'DJ Eugene' });
    expect(id.handle).toBe('DJ Eugene');
    expect(id.userId).toBe('user-9');
    expect(id.authenticated).toBe(true);
    expect(id.clientId).toMatch(/^c_/);
  });

  it('assigns a color not already taken by present peers', () => {
    const present = [
      { clientId: 'c_a', color: PALETTE[0], handle: 'Owl' },
      { clientId: 'c_b', color: PALETTE[1], handle: 'Fox' },
    ];
    const id = makeAuthenticatedIdentity(present, { userId: 'u', handle: 'Name' });
    expect(id.color).not.toBe(PALETTE[0]);
    expect(id.color).not.toBe(PALETTE[1]);
  });
});
```

(The file already imports `PALETTE`/`HANDLES` and `makeIdentity` — extend the existing import line to add `makeAuthenticatedIdentity`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/server -- identity`
Expected: FAIL — `makeAuthenticatedIdentity` is not exported.

- [ ] **Step 3: Implement it and set the new fields in `makeIdentity`**

In `packages/server/src/room/identity.ts`, update `makeIdentity` to set the new fields explicitly, and add the sibling:

```ts
export function makeIdentity(existing: readonly Identity[]): Identity {
  const takenColors = new Set<string>(existing.map((i) => i.color));
  const takenHandles = new Set<string>(existing.map((i) => i.handle));
  return {
    clientId: generateClientId(),
    color: assignColor(takenColors),
    handle: assignHandle(takenHandles),
    userId: null,
    authenticated: false,
  };
}

/**
 * Identity for an authenticated (Google) user. clientId is still per-connection
 * unique; the account is carried via userId. Handle comes from the account
 * (custom username or Google name); color is assigned to avoid present peers.
 */
export function makeAuthenticatedIdentity(
  existing: readonly Identity[],
  account: { userId: string; handle: string },
): Identity {
  const takenColors = new Set<string>(existing.map((i) => i.color));
  return {
    clientId: generateClientId(),
    color: assignColor(takenColors),
    handle: account.handle,
    userId: account.userId,
    authenticated: true,
  };
}
```

Note: `assignHandle(...)` now returns `string` (since `Handle = string`), so the previous `as Handle` coercion on the `makeIdentity` return is no longer needed — remove it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fiddle/server -- identity`
Expected: PASS.

- [ ] **Step 5: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

```bash
git add packages/server/src/room/identity.ts packages/server/src/room/identity.test.ts
git commit -m "feat(server): makeAuthenticatedIdentity + explicit guest identity fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `ConnectionHandler` hello auth integration

**Files:**
- Modify: `packages/server/src/sync/ConnectionHandler.ts`
- Test: `packages/server/src/sync/ConnectionHandler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/src/sync/ConnectionHandler.test.ts` a describe block. Use the file's existing harness for building a handler + fake socket (mirror how other tests in this file construct a `ConnectionHandler`), supplying the two new constructor args: a fake `verify` and an `InMemoryProfileStore`. The three behaviors to assert:

```ts
import { InMemoryProfileStore } from '../profile/InMemoryProfileStore.js';

// `verify` fake: maps a token string to claims (or null).
function fakeVerify(map: Record<string, { userId: string; googleName: string }>) {
  return async (token: string) => map[token] ?? null;
}

describe('ConnectionHandler — auth on hello', () => {
  it('uses the profile username as the handle when set', async () => {
    const profiles = new InMemoryProfileStore({ 'user-1': 'DJ Eugene' });
    const verify = fakeVerify({ 'good-token': { userId: 'user-1', googleName: 'Eugene B' } });
    // build handler with (verify, profiles); send a hello with token 'good-token'
    // assert the welcome frame sent to the socket has handle === 'DJ Eugene',
    // authenticated === true, userId === 'user-1'.
  });

  it('falls back to the Google name when no username is set', async () => {
    const profiles = new InMemoryProfileStore();
    const verify = fakeVerify({ 'good-token': { userId: 'user-2', googleName: 'Eugene B' } });
    // hello with token 'good-token' → welcome.handle === 'Eugene B', authenticated === true.
  });

  it('sends a fatal auth.invalid error for a present-but-invalid token', async () => {
    const profiles = new InMemoryProfileStore();
    const verify = fakeVerify({}); // any token → null
    // hello with token 'bad' → an error frame { code: 'auth.invalid', fatal: true }; socket closed.
  });

  it('keeps the guest path unchanged when no token is sent', async () => {
    const profiles = new InMemoryProfileStore();
    const verify = fakeVerify({});
    // hello with NO token → welcome.authenticated is falsy, handle drawn from HANDLES.
  });
});
```

Fill in the handler construction + frame assertions following the patterns already present in `ConnectionHandler.test.ts` (it already builds a fake `SocketLike` that records sent frames). For the multi-tab guard, add:

```ts
  it('two connections with the same userId both appear; closing one keeps the other', async () => {
    // Two handlers in the same room, same token (same userId), distinct sockets.
    // After both hello: store.listConnected has two entries with distinct clientIds.
    // Close one: the other is still in listConnected.
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/server -- ConnectionHandler`
Expected: FAIL — constructor signature mismatch / `auth.invalid` path absent.

- [ ] **Step 3: Implement the integration**

In `packages/server/src/sync/ConnectionHandler.ts`:

Add imports:

```ts
import type { ProfileStore } from '../profile/ProfileStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';
import { makeIdentity, makeAuthenticatedIdentity } from '../room/identity.js';
```

(Replace the existing `import { makeIdentity } ...` line.)

Extend the constructor with two new dependencies (added after `log`, before the optional `heartbeat`):

```ts
  constructor(
    private readonly roomId: string,
    private readonly socket: SocketLike,
    private readonly store: RoomStore,
    private readonly pool: RoomConnectionPool,
    private readonly log: Log,
    private readonly verify: (token: string) => Promise<VerifiedClaims | null>,
    private readonly profiles: ProfileStore,
    heartbeat?: Heartbeat,
  ) {
    this.heartbeat = heartbeat ?? new Heartbeat(socket);
  }
```

In `handleHello`, replace the identity-resolution block (the `let identity ... if (!identity) { ... makeIdentity ... }` section) with a token-first version:

```ts
    let identity: Identity | null = null;
    let resumeIdentityWarning: 'unknown_client' | null = null;

    if (msg.token) {
      const claims = await this.verify(msg.token);
      if (!claims) {
        this.fatal('auth.invalid', 'invalid or expired auth token');
        return;
      }
      const present = await this.store.listConnected(this.roomId);
      const username = await this.profiles.getUsername(claims.userId);
      identity = makeAuthenticatedIdentity(present, {
        userId: claims.userId,
        handle: username ?? claims.googleName,
      });
      await this.store.setIdentity(this.roomId, identity);
    } else {
      // Guest path (unchanged): resume an existing identity if the client
      // presented a known clientId, else mint a fresh one.
      if (msg.clientId) {
        const existing = await this.store.getIdentity(this.roomId, msg.clientId);
        if (existing) {
          identity = existing;
        } else {
          resumeIdentityWarning = 'unknown_client';
        }
      }
      if (!identity) {
        const present = await this.store.listConnected(this.roomId);
        identity = makeIdentity(present);
        await this.store.setIdentity(this.roomId, identity);
      }
    }
```

The rest of `handleHello` (welcome construction, `resumeIdentityWarning` error, catch-up via `resumeFromOpId`, sync.complete, presence fan-out) stays exactly as-is — `welcome` already spreads `identity` fields and includes the roster, so `userId`/`authenticated` flow out automatically once the `WelcomeMessage`/roster carry them.

Add `userId` + `authenticated` to the `WelcomeMessage` the handler builds, so the originator learns its own auth state:

```ts
    const welcome: WelcomeMessage = {
      v: 1,
      type: 'welcome',
      clientId: identity.clientId,
      color: identity.color,
      handle: identity.handle,
      userId: identity.userId ?? null,
      authenticated: identity.authenticated ?? false,
      opIdHead,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      roster,
    };
```

Then add the two optional fields to `WelcomeMessage` in `packages/shared/src/protocol/types.ts`:

```ts
export interface WelcomeMessage {
  v: 1;
  type: 'welcome';
  clientId: string;
  color: PaletteColor;
  handle: Handle;
  userId?: string | null;
  authenticated?: boolean;
  opIdHead: number;
  schemaVersion: number;
  roster: Identity[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fiddle/server -- ConnectionHandler`
Expected: PASS (all auth cases + multi-tab guard).

- [ ] **Step 5: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. (Compilation of `server.ts`/`ws.ts` still passes the OLD 5-arg constructor — they break in Task 7. If `npm run build` fails here because `server.ts` doesn't pass the new args, do Task 7's wiring in the same commit; otherwise commit now.)

> **Sequencing note:** the new constructor args make `server.ts`/`routes/ws.ts` fail to typecheck until Task 7. If the gate is red solely because of those two callers, proceed straight into Task 7 and commit Tasks 6+7 together. Do not leave the gate red across a commit boundary.

```bash
git add packages/server/src/sync/ConnectionHandler.ts packages/server/src/sync/ConnectionHandler.test.ts packages/shared/src/protocol/types.ts
git commit -m "feat(server): verify JWT on hello, resolve handle from profile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Wire auth deps into the server boot path

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/routes/ws.ts`
- Test: `packages/server/src/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/server.test.ts` (it already builds the server and hits routes):

```ts
it('boots with no Supabase env (guest-only) and serves /health', async () => {
  delete process.env.SUPABASE_JWKS_URL;
  delete process.env.DATABASE_URL;
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/server -- server`
Expected: FAIL — `buildServer` does not yet construct the new deps (or `wsRoute` Deps shape mismatch surfaces at typecheck).

- [ ] **Step 3: Build the deps from env and inject them**

In `packages/server/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import postgres from 'postgres';
import { healthRoute } from './routes/health.js';
import { wsRoute } from './routes/ws.js';
import { InMemoryRoomStore } from './room/InMemoryRoomStore.js';
import { ConnectionPool } from './sync/ConnectionPool.js';
import { verifyToken, remoteJwks } from './auth/verifyToken.js';
import { InMemoryProfileStore } from './profile/InMemoryProfileStore.js';
import { PostgresProfileStore } from './profile/PostgresProfileStore.js';
import type { ProfileStore } from './profile/ProfileStore.js';
import type { VerifiedClaims } from './auth/verifyToken.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const store = new InMemoryRoomStore();
  const pool = new ConnectionPool();

  // Auth + profiles are optional: with no Supabase env the server runs
  // guest-only (verify always rejects tokens; profile store is empty).
  const jwksUrl = process.env.SUPABASE_JWKS_URL;
  const dbUrl = process.env.DATABASE_URL;

  let verify: (token: string) => Promise<VerifiedClaims | null>;
  if (jwksUrl) {
    const jwks = remoteJwks(jwksUrl);
    verify = (token: string) => verifyToken(token, jwks);
  } else {
    verify = async () => null;
  }

  const profiles: ProfileStore = dbUrl
    ? new PostgresProfileStore(postgres(dbUrl))
    : new InMemoryProfileStore();

  app.register(websocket);
  app.register(healthRoute);
  app.register(async (a) => wsRoute(a, { store, pool, verify, profiles }));
  return app;
}
```

In `packages/server/src/routes/ws.ts`, extend `Deps` and pass the new args to the handler:

```ts
import type { ProfileStore } from '../profile/ProfileStore.js';
import type { VerifiedClaims } from '../auth/verifyToken.js';

interface Deps {
  store: RoomStore;
  pool: ConnectionPool;
  verify: (token: string) => Promise<VerifiedClaims | null>;
  profiles: ProfileStore;
}
```

```ts
    const handler = new ConnectionHandler(
      roomId,
      adapted,
      deps.store,
      deps.pool,
      (msg, fields) => app.log.info(fields ?? {}, msg),
      deps.verify,
      deps.profiles,
    );
```

- [ ] **Step 4: Run test + full server suite to verify it passes**

Run: `npm test -w @fiddle/server`
Expected: PASS, including the existing e2e (`protocol.e2e.test.ts`) — it sends guest hellos (no token), which hit the unchanged guest path, and `buildServer` now supplies a `verify` that rejects tokens + an empty profile store.

- [ ] **Step 5: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (server `build` runs the esbuild bundle; `postgres` + `jose` stay external via `--packages=external`).

```bash
git add packages/server/src/server.ts packages/server/src/routes/ws.ts packages/server/src/server.test.ts
git commit -m "feat(server): wire JWT verify + ProfileStore from env (guest-only fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Client Supabase client + `useAuth`

**Files:**
- Create: `packages/client/src/auth/supabase.ts`
- Create: `packages/client/src/auth/useAuth.ts`
- Test: `packages/client/src/auth/useAuth.test.ts`
- Modify: `packages/client/package.json` (add `@supabase/supabase-js`)

- [ ] **Step 1: Add the Supabase JS dependency**

Run: `npm install -w @fiddle/client @supabase/supabase-js`
Expected: it appears under `packages/client/package.json` dependencies.

- [ ] **Step 2: Write the failing test**

Create `packages/client/src/auth/useAuth.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the supabase singleton module so useAuth talks to a fake client.
const authState = { current: null as null | { user: { id: string }; access_token: string } };
let authCallback: ((event: string, session: unknown) => void) | null = null;

const fakeClient = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: authState.current } })),
    onAuthStateChange: vi.fn((cb: (e: string, s: unknown) => void) => {
      authCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  },
  from: vi.fn(() => ({
    update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
  })),
};

vi.mock('./supabase', () => ({ supabase: fakeClient }));

import { useAuth } from './useAuth';

beforeEach(() => {
  authState.current = null;
  authCallback = null;
  vi.clearAllMocks();
});

describe('useAuth', () => {
  it('starts signed out', async () => {
    const auth = useAuth();
    await auth.ready;
    expect(auth.isAuthenticated.value).toBe(false);
    expect(auth.accessToken.value).toBeUndefined();
  });

  it('reflects a sign-in pushed through onAuthStateChange', async () => {
    const auth = useAuth();
    await auth.ready;
    authCallback?.('SIGNED_IN', { user: { id: 'u-1' }, access_token: 'tok-1' });
    expect(auth.isAuthenticated.value).toBe(true);
    expect(auth.accessToken.value).toBe('tok-1');
  });

  it('signInWithGoogle calls signInWithOAuth with provider google', async () => {
    const auth = useAuth();
    await auth.ready;
    await auth.signInWithGoogle();
    expect(fakeClient.auth.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
  });

  it('setUsername maps a unique violation to { ok: false, reason: "taken" }', async () => {
    fakeClient.from.mockReturnValueOnce({
      update: () => ({ eq: async () => ({ error: { code: '23505' } }) }),
    } as never);
    const auth = useAuth();
    await auth.ready;
    authCallback?.('SIGNED_IN', { user: { id: 'u-1' }, access_token: 'tok-1' });
    const res = await auth.setUsername('taken-name');
    expect(res).toEqual({ ok: false, reason: 'taken' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @fiddle/client -- useAuth`
Expected: FAIL — `useAuth`/`supabase` modules do not exist.

- [ ] **Step 4: Implement the singleton + composable**

Create `packages/client/src/auth/supabase.ts`:

```ts
// Supabase client singleton. Null when the project isn't configured (no env
// vars) so the app still boots guest-only without an auth backend.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;
```

Create `packages/client/src/auth/useAuth.ts`:

```ts
// Reactive auth state for the app. Module-singleton like presence: one session
// per tab. Wraps the Supabase client; no-ops gracefully when supabase is null
// (unconfigured) so guests are unaffected.
import { ref, computed, type Ref } from 'vue';
import { supabase } from './supabase.js';

interface SessionLike {
  user: { id: string };
  access_token: string;
}

const session: Ref<SessionLike | null> = ref(null);

export type SetUsernameResult = { ok: true } | { ok: false; reason: 'taken' | 'not-authed' };

// Resolves once the initial getSession + listener are wired, so callers (and
// tests) can await a known starting point.
const ready: Promise<void> = (async () => {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  session.value = (data.session as SessionLike | null) ?? null;
  supabase.auth.onAuthStateChange((_event, s) => {
    session.value = (s as SessionLike | null) ?? null;
  });
})();

const isAuthenticated = computed(() => session.value !== null);
const accessToken = computed(() => session.value?.access_token);

async function signInWithGoogle(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
}

async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Writes the chosen username to the user's own profiles row (RLS-guarded).
// A Postgres unique violation (23505) means the name is taken.
async function setUsername(username: string): Promise<SetUsernameResult> {
  if (!supabase || !session.value) return { ok: false, reason: 'not-authed' };
  const { error } = await supabase
    .from('profiles')
    .update({ username })
    .eq('id', session.value.user.id);
  if (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false, reason: 'taken' };
    throw error;
  }
  return { ok: true };
}

export function useAuth() {
  return { ready, isAuthenticated, accessToken, session, signInWithGoogle, signOut, setUsername };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @fiddle/client -- useAuth`
Expected: PASS.

- [ ] **Step 6: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

```bash
git add packages/client/src/auth/supabase.ts packages/client/src/auth/useAuth.ts packages/client/src/auth/useAuth.test.ts packages/client/package.json package-lock.json
git commit -m "feat(client): Supabase client singleton + useAuth composable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: `WsClient` — token in hello + `reconnect()`

**Files:**
- Modify: `packages/client/src/sync/WsClient.ts`
- Test: `packages/client/src/sync/WsClient.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/sync/WsClient.test.ts` (it already has a `MockWebSocket` + in-memory storage harness — reuse it):

```ts
it('includes the token from getToken in the hello frame', () => {
  const sent: string[] = [];
  // Build a WsClient with socketCtor = MockWebSocket, fresh storage, and
  // getToken: () => 'tok-abc'. Capture frames the mock socket "sends".
  // After connect() + the mock socket opening, the first frame is hello.
  // Assert JSON.parse(hello).token === 'tok-abc'.
});

it('omits token when getToken returns undefined (guest)', () => {
  // Same, getToken: () => undefined → hello has no `token` key.
});

it('reconnect() closes and reopens, re-sending hello', () => {
  // After reaching a connected state, call reconnect(); assert the socket was
  // closed and a new one opened and a fresh hello sent.
});
```

Fill these in following the existing harness in the file (how it instantiates `MockWebSocket`, drives `onopen`, and reads the frames the mock recorded).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/client -- WsClient`
Expected: FAIL — `getToken` option ignored / `reconnect` undefined.

- [ ] **Step 3: Implement the option, hello field, and reconnect**

In `packages/client/src/sync/WsClient.ts`, add to `WsClientOptions`:

```ts
  // Returns the current Supabase access token, or undefined for a guest.
  // Read fresh on every hello so a reconnect after login carries the token.
  getToken?: () => string | undefined;
```

In `sendHello`, attach the token when present (build the base hello, then add `token`):

```ts
  private sendHello(): void {
    const persisted = this.getPersisted();
    const hello: HelloMessage = persisted?.clientId
      ? {
          v: 1,
          type: 'hello',
          schemaVersion: PROJECT_SCHEMA_VERSION,
          clientId: persisted.clientId,
          resumeFromOpId: persisted.opIdLastSeen,
        }
      : {
          v: 1,
          type: 'hello',
          schemaVersion: PROJECT_SCHEMA_VERSION,
        };
    const token = this.opts.getToken?.();
    if (token) hello.token = token;
    this.socket?.send(JSON.stringify(hello));
  }
```

Add a public `reconnect()` that tears down and reopens (token is re-read on the new hello):

```ts
  // Force a fresh connection — used when auth state changes so the server
  // re-derives identity from the (now present/absent) token.
  reconnect(): void {
    this.disconnect();
    this.connect();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fiddle/client -- WsClient`
Expected: PASS.

- [ ] **Step 5: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

```bash
git add packages/client/src/sync/WsClient.ts packages/client/src/sync/WsClient.test.ts
git commit -m "feat(client): WsClient sends auth token in hello + reconnect()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Wire auth into `useSynth` (token + reconnect on auth change)

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts`
- Test: `packages/client/src/composables/useSynth.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/composables/useSynth.test.ts` (it already has `makeFakeWsClient` + `setWsClientFactory`). Assert the factory receives a `getToken` option, and that flipping the auth session triggers `reconnect()` on the fake client:

```ts
it('passes getToken to the WsClient factory', async () => {
  // After ensureAudio()/buildSyncState, the opts captured by the fake factory
  // include a getToken function.
  expect(typeof capturedOpts.getToken).toBe('function');
});

it('reconnects the WsClient when the auth session changes', async () => {
  // With a fake WsClient exposing a reconnect spy, change useAuth().session.value
  // (import the same module the composable uses) and flush a tick; assert
  // reconnect was called.
});
```

Add a `reconnect: vi.fn()` to `makeFakeWsClient` so the spy exists, and capture `opts` in the factory.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: FAIL — no `getToken` passed / no reconnect-on-auth-change watcher.

- [ ] **Step 3: Implement the wiring**

In `packages/client/src/composables/useSynth.ts`, import `useAuth` and `watch`:

```ts
import { watch } from 'vue';
import { useAuth } from '../auth/useAuth.js';
```

In `buildSyncState()`, pass `getToken` into the factory opts (alongside `url`, `roomId`, `onMessage`, `onStateChange`):

```ts
  const auth = useAuth();
  wsClient = wsClientFactory({
    url: wsUrl,
    roomId,
    getToken: () => auth.accessToken.value,
    onMessage: (msg) => dispatchServerMessage(msg, {
      project,
      wsClient: wsClient!,
      outbox: outbox!,
      onFatalError: (code, message) => { fatalError.value = { code, message }; },
    }),
    onStateChange: (s) => {
      if (s === 'closed' && outbox) outbox.onClosed();
    },
  });
```

After `wsClient.connect();` at the end of `buildSyncState()`, add a watcher that reconnects on auth identity change (guard against re-entrancy on first run):

```ts
  // Re-handshake when the user logs in/out so the server re-derives identity
  // from the (now present/absent) token. Watch the user id, not the token —
  // Supabase silently refreshes the token periodically and we don't want to
  // bounce the socket on every refresh.
  watch(
    () => auth.session.value?.user.id ?? null,
    (next, prev) => {
      if (next === prev) return;
      wsClient?.reconnect();
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: PASS.

- [ ] **Step 5: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): supply auth token to sync + reconnect on login/logout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: RoomBar login UI + username editor

**Files:**
- Modify: `packages/client/src/components/RoomBar.vue`

- [ ] **Step 1: Add the auth controls to RoomBar**

Replace `packages/client/src/components/RoomBar.vue` with the roster (unchanged) plus an auth section. When signed out: a "Sign in with Google" button. When signed in: the handle + a small inline username editor (text input + Save) that calls `setUsername` and shows a "taken" message on conflict, plus a Sign out button.

```vue
<template>
  <div class="room-bar">
    <div class="roster" v-if="roster.length">
      <div
        v-for="r in roster"
        :key="r.clientId"
        class="chip"
        :class="{ self: r.clientId === selfClientId }"
        :style="{ background: r.color }"
        :title="r.clientId === selfClientId ? `${r.handle} (you)` : r.handle"
      >
        {{ r.handle }}
      </div>
    </div>

    <div class="auth">
      <button v-if="!auth.isAuthenticated.value" class="auth-btn" @click="auth.signInWithGoogle()">
        Sign in with Google
      </button>
      <template v-else>
        <input
          v-model="draftName"
          class="username-input"
          placeholder="username"
          @keyup.enter="save"
        />
        <button class="auth-btn" :disabled="saving" @click="save">Save</button>
        <span v-if="status" class="status" :class="status">{{ statusText }}</span>
        <button class="auth-btn" @click="auth.signOut()">Sign out</button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';

const auth = useAuth();
const draftName = ref('');
const saving = ref(false);
const status = ref<'' | 'ok' | 'taken'>('');
const statusText = ref('');

async function save() {
  if (!draftName.value.trim()) return;
  saving.value = true;
  status.value = '';
  try {
    const res = await auth.setUsername(draftName.value.trim());
    if (res.ok) {
      status.value = 'ok';
      statusText.value = 'saved';
    } else {
      status.value = 'taken';
      statusText.value = res.reason === 'taken' ? 'taken' : 'sign in first';
    }
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.room-bar {
  display: flex;
  gap: 12px;
  padding: 4px 12px;
  align-items: center;
  justify-content: space-between;
}
.roster { display: flex; gap: 8px; align-items: center; }
.chip {
  padding: 2px 10px;
  border-radius: 12px;
  color: #111;
  font-size: 12px;
  font-weight: 600;
  outline: 2px solid transparent;
}
.chip.self { outline-color: #fff; }
.auth { display: flex; gap: 6px; align-items: center; }
.auth-btn {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
}
.auth-btn:disabled { opacity: 0.5; cursor: default; }
.username-input {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #111;
  color: #eee;
  width: 110px;
}
.status { font-size: 11px; }
.status.ok { color: #2ECC40; }
.status.taken { color: #FF4136; }
</style>
```

Note: the original `v-if="roster.length"` on the outer wrapper is intentionally dropped — the bar must render even with an empty roster so the sign-in button is always reachable. The roster sub-div keeps its own `v-if`.

- [ ] **Step 2: Verify in the browser (user-driven)**

Run: `npm run dev` and open http://localhost:5173.
Expected (with Supabase env unset, i.e. `supabase === null`): the "Sign in with Google" button renders and clicking it is a no-op (graceful). With env set + after Task 12's migration, sign-in opens the Google flow; after returning, the username editor appears and Save persists.

This is a visual/manual check — the maintainer verifies. No automated UI test in this task (the logic paths — `signInWithGoogle`, `setUsername` — are already covered by `useAuth.test.ts`).

- [ ] **Step 3: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (`vue-tsc` typechecks the SFC).

```bash
git add packages/client/src/components/RoomBar.vue
git commit -m "feat(client): RoomBar Google sign-in + username editor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Supabase migration, config, and docs

**Files:**
- Create: `supabase/migrations/0001_profiles.sql`
- Create: `.env.example`
- Modify: `.gitignore`
- Modify: `render.yaml`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0001_profiles.sql`:

```sql
-- Profiles: one row per authenticated user. Holds the claimable username; the
-- realtime server reads this (privileged) to resolve a room handle. RLS guards
-- only the browser's direct access — the server connects with DATABASE_URL.

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique,                       -- claimable, nullable until set
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "own profile read"   on public.profiles for select using  (auth.uid() = id);
create policy "own profile write"  on public.profiles for update using  (auth.uid() = id);
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);

-- Auto-create an empty profile row on signup (standard Supabase trigger).
create function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

- [ ] **Step 2: Write `.env.example` and ignore real `.env`**

Create `.env.example` at the repo root:

```bash
# === Client (Vite) — packages/client/.env.local ===
# Supabase project URL + anon (publishable) key. Absent → app runs guest-only.
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# WebSocket sync server (existing).
VITE_WS_URL=ws://localhost:8080

# === Server (Fastify) — packages/server/.env ===
# JWKS endpoint for local JWT verification. Absent → server runs guest-only.
SUPABASE_JWKS_URL=https://YOUR_PROJECT.supabase.co/auth/v1/.well-known/jwks.json
# Privileged Postgres connection string (Supabase pooler). Absent → in-memory
# profile store (no usernames). Use the SESSION/transaction pooler URL.
DATABASE_URL=postgres://USER:PASSWORD@HOST:6543/postgres
```

In `.gitignore`, add (under the existing `*.local` line) so real env files never get committed:

```
# Environment files (keep .env.example, ignore real secrets)
.env
.env.*
!.env.example
```

- [ ] **Step 3: Add the server env vars to render.yaml**

In `render.yaml`, under `envVars`, append (leave the existing `NODE_VERSION` entry):

```yaml
      # Auth + persistence (Milestone 1). Set the values in the Render dashboard
      # (sync: false keeps secrets out of the repo). Absent → guest-only.
      - key: SUPABASE_JWKS_URL
        sync: false
      - key: DATABASE_URL
        sync: false
```

- [ ] **Step 4: Document the architecture**

In `docs/ARCHITECTURE.md`, add a new section describing the auth/persistence foundation (Google sign-in, JWT-on-hello, `ProfileStore`, the guest fallback, the `clientId`-vs-`userId` decision) and a decision-appendix entry (next free `Dn`). Keep it consistent with the existing section/decision numbering and the spec at `docs/superpowers/specs/2026-05-30-auth-persistence-foundation-design.md`. Include the one-time manual setup checklist:

```markdown
### One-time Supabase setup (manual, done in dashboards)

1. Create a Supabase project; note its URL + anon key.
2. Google Cloud Console → create an OAuth 2.0 client (Web). Copy client id + secret.
3. Supabase → Authentication → Providers → Google: paste client id/secret; enable.
4. Supabase → Authentication → URL config: add the app origins to redirect URLs
   (local http://localhost:5173 + the Vercel domain).
5. Run `supabase/migrations/0001_profiles.sql` (SQL editor or `supabase db push`).
6. Set client env (Vercel): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
7. Set server env (Render): SUPABASE_JWKS_URL, DATABASE_URL (the pooler string).
```

- [ ] **Step 5: Verify the gate, then commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (docs/config only — no code change).

```bash
git add supabase/migrations/0001_profiles.sql .env.example .gitignore render.yaml docs/ARCHITECTURE.md
git commit -m "chore: profiles migration, env template, render + architecture docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final review

After all tasks: dispatch a final code-reviewer over the whole branch, then use
`superpowers:finishing-a-development-branch`. Manual end-to-end (maintainer):
with real Supabase env set and the migration applied, sign in with Google in one
browser, set a username, confirm a second (guest) browser in the same room sees
the chosen handle in the roster; sign out and confirm the handle reverts to a
guest animal name.

## Notes for the implementer

- **npm only.** Never create or commit a `pnpm-lock.yaml`. Dependency installs update `package-lock.json`.
- **Commit cadence:** the gate (`npm run typecheck && npm test && npm run build`) must be green before each commit. Tasks 6 and 7 may need to land in one commit (see the sequencing note in Task 6) since the new constructor args break `server.ts` until Task 7.
- **Guest path is sacred:** every change is additive. A connection with no token must behave exactly as it does today (this is asserted in Task 6, step 1, and by the unchanged `protocol.e2e.test.ts`).
- **No secrets in git:** `.env.example` is the only env file committed.
