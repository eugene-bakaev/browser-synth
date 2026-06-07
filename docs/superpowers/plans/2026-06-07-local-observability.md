# Local Dev Environment + Exhaustive Observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Dockerized local Postgres + OpenObserve and instrument the `@fiddle/server` with OpenTelemetry (traces + metrics + logs) — gated behind `FIDDLE_OTEL` so production stays un-instrumented — making every HTTP, WS, and DB interaction visible for later analysis.

**Architecture:** A `docker-compose.yml` runs `postgres:16` (seeded with an auth-decoupled local schema) and OpenObserve. The server keeps the real Supabase JWKS (so real Google login works) but points `DATABASE_URL` at local Postgres. OTel is bootstrapped in a flag-gated module loaded before the Fastify instance is created; HTTP spans come from `@fastify/otel` (diagnostics-channel based — no `import-in-the-middle` loader hook), DB spans/metrics from thin store wrappers, WS frame metrics from the `wsRoute` socket boundary (the `ConnectionHandler` is untouched), and domain logs via a dual pino+OTel log helper. Everything no-ops when the flag is off because the OTel API returns no-op tracers/meters without an SDK.

**Tech Stack:** Node + TypeScript (ESM, `tsx`), Fastify v5, porsager `postgres`, Vitest; OpenTelemetry JS (`@opentelemetry/sdk-node`, OTLP/HTTP exporters, `@fastify/otel`); Docker Compose (`postgres:16`, `public.ecr.aws/zinclabs/openobserve:latest`).

**Reference spec:** `docs/superpowers/specs/2026-06-06-local-observability-design.md`

**Conventions for every task:** Work on the current `feat/local-observability` branch. Never edit on `main`. Run the gate (`npm run typecheck && npm test && npm run build` from repo root) before the final task's commit; per-task runs use the per-file commands shown. Commit only the files each task lists (never `git add -A`). End every commit message with:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## File Structure

**Create:**
- `packages/server/db/local-init.sql` — auth-decoupled schema for local Postgres (runs once on first container boot).
- `packages/server/src/otel/sdk.ts` — flag check + NodeSDK bootstrap/shutdown.
- `packages/server/src/otel/sdk.test.ts`
- `packages/server/src/otel/db.ts` — `withDbSpan` + instrumented store wrappers + meters.
- `packages/server/src/otel/db.test.ts`
- `packages/server/src/otel/ws.ts` — WS frame recorders + `frameType`.
- `packages/server/src/otel/ws.test.ts`
- `packages/server/src/otel/log.ts` — `makeLog` (pino + OTel logs).
- `packages/server/src/otel/log.test.ts`
- `docs/LOCAL_OBSERVABILITY.md` — runbook.

**Modify:**
- `docker-compose.yml` — replace the broken aspirational file with postgres + openobserve services.
- `packages/server/package.json` — OTel deps + `dev:obs` script.
- `package.json` (root) — `dev:obs` / `dev:obs:server` convenience scripts.
- `packages/server/src/index.ts` — call `startOtel()` before `buildServer()`; `shutdownOtel()` on signal.
- `packages/server/src/server.ts` — wrap stores with instrumenters; build `makeLog`; pass `log` to `wsRoute`.
- `packages/server/src/routes/ws.ts` — record inbound/outbound WS frames; accept + use `log`.

---

## Task 1: Local Docker stack (Postgres + OpenObserve) + schema

**Files:**
- Create: `packages/server/db/local-init.sql`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Write the local schema**

Create `packages/server/db/local-init.sql` (mirrors the prod migrations with the Supabase auth couplings removed — no `auth.users` FK, no RLS, no signup trigger):

```sql
-- Local-dev schema for Fiddle Synth. NOT the production schema: the
-- auth.users FK, RLS policies, and signup trigger from supabase/migrations are
-- intentionally dropped. RLS guards only direct browser DB access, which never
-- happens — the privileged server is the sole client. owner_user_id stays a
-- plain uuid so a REAL Supabase login (whose user id has no local auth.users
-- row) can still create and persist a session.

create table if not exists sessions (
  id              text primary key,
  name            text not null,
  description     text not null default '',
  owner_user_id   uuid,
  owner_client_id text,
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists sessions_owner_user_id_idx on sessions (owner_user_id);

create table if not exists session_snapshots (
  session_id text primary key references sessions(id) on delete cascade,
  project    jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists profiles (
  id         uuid primary key,
  username   text unique,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Replace docker-compose.yml**

Overwrite `docker-compose.yml` (the existing file references a non-existent `packages/server/Dockerfile`):

```yaml
# Local dev infrastructure for observability work. The server itself runs on
# the host (npm run dev:obs) against these. See docs/LOCAL_OBSERVABILITY.md.
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: fiddle
      POSTGRES_PASSWORD: fiddle
      POSTGRES_DB: fiddle
    ports:
      - "5432:5432"
    volumes:
      - fiddle-pgdata:/var/lib/postgresql/data
      - ./packages/server/db/local-init.sql:/docker-entrypoint-initdb.d/0001-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fiddle -d fiddle"]
      interval: 5s
      timeout: 3s
      retries: 10

  openobserve:
    image: public.ecr.aws/zinclabs/openobserve:latest
    environment:
      ZO_ROOT_USER_EMAIL: admin@fiddle.local
      ZO_ROOT_USER_PASSWORD: fiddle-dev-password
      ZO_DATA_DIR: /data
    ports:
      - "5080:5080"
    volumes:
      - fiddle-o2data:/data

volumes:
  fiddle-pgdata:
  fiddle-o2data:
```

- [ ] **Step 3: Bring the stack up and verify**

Run:
```bash
docker compose up -d
docker compose ps
```
Expected: both `postgres` and `openobserve` show state `running` (postgres `healthy`).

- [ ] **Step 4: Verify the schema applied**

Run:
```bash
docker compose exec -T postgres psql -U fiddle -d fiddle -c '\dt'
```
Expected: lists `sessions`, `session_snapshots`, `profiles`.

- [ ] **Step 5: Verify OpenObserve UI is reachable**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5080/web/
```
Expected: `200` (or a `3xx` redirect to the login page — both mean it's serving). The UI logs in with `admin@fiddle.local` / `fiddle-dev-password`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml packages/server/db/local-init.sql
git commit -m "$(cat <<'EOF'
chore(obs): local docker stack — postgres + openobserve + dev schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: OTel dependencies + flag-gated bootstrap

**Files:**
- Modify: `packages/server/package.json`
- Create: `packages/server/src/otel/sdk.ts`, `packages/server/src/otel/sdk.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Install OTel dependencies**

Run (resolves current compatible versions and updates the lockfile):
```bash
npm install -w @fiddle/server \
  @opentelemetry/api @opentelemetry/api-logs \
  @opentelemetry/sdk-node @opentelemetry/sdk-metrics @opentelemetry/sdk-logs \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/exporter-logs-otlp-http \
  @fastify/otel
```
Expected: installs succeed; `packages/server/package.json` gains these under `dependencies`. (They are inert until `startOtel()` runs, so prod is unaffected.)

- [ ] **Step 2: Write the failing test for the bootstrap guard**

Create `packages/server/src/otel/sdk.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { isOtelEnabled, startOtel, shutdownOtel } from './sdk.js';

describe('otel bootstrap', () => {
  afterEach(async () => {
    delete process.env.FIDDLE_OTEL;
    await shutdownOtel();
  });

  it('isOtelEnabled reflects the FIDDLE_OTEL flag', () => {
    delete process.env.FIDDLE_OTEL;
    expect(isOtelEnabled()).toBe(false);
    process.env.FIDDLE_OTEL = '1';
    expect(isOtelEnabled()).toBe(true);
  });

  it('startOtel is a no-op when the flag is unset (no throw, idempotent)', async () => {
    delete process.env.FIDDLE_OTEL;
    expect(() => startOtel()).not.toThrow();
    expect(() => startOtel()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
cd packages/server && npx vitest run src/otel/sdk.test.ts
```
Expected: FAIL — cannot find module `./sdk.js`.

- [ ] **Step 4: Implement the bootstrap**

Create `packages/server/src/otel/sdk.ts`:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
// Default export per @fastify/otel NodeSDK docs; the class is also exported as a
// named binding if this import ever fails to typecheck.
import FastifyOtelInstrumentation from '@fastify/otel';

// The single switch. Off (unset) → no SDK starts, the OTel API hands out no-op
// tracers/meters/loggers, and every instrumentation call elsewhere is free.
// Render/production never sets this, so prod is fully un-instrumented.
export function isOtelEnabled(): boolean {
  return Boolean(process.env.FIDDLE_OTEL);
}

let sdk: NodeSDK | null = null;

// Endpoint, headers, and service name come from OTEL_* env (set by the dev:obs
// script), so nothing is hard-coded and there is no off-machine default.
export function startOtel(): void {
  if (!isOtelEnabled() || sdk) return;
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 10_000,
    }),
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: (opts) => opts.url.startsWith('/health'),
      }),
    ],
  });
  sdk.start();
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd packages/server && npx vitest run src/otel/sdk.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Wire the bootstrap into `index.ts`**

Edit `packages/server/src/index.ts`. Add the import after the `buildServer` import, call `startOtel()` before `buildServer()`, and shut it down on signal.

Replace the top imports + `const app` block:
```ts
import './loadEnv.js';
import { startOtel, shutdownOtel } from './otel/sdk.js';
import { buildServer } from './server.js';
import { installProcessSafetyNet } from './processSafetyNet.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

// Must run before buildServer() creates the Fastify instance: @fastify/otel
// subscribes to the 'fastify.initialization' diagnostics channel inside
// sdk.start(), and only instances created after that subscription are traced.
startOtel();

const app = buildServer();
```

In the signal loop, replace the `.then(() => process.exit(0))` line so OTel flushes first:
```ts
  process.once(signal, () => {
    app
      .close()
      .then(() => shutdownOtel())
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
  });
```

- [ ] **Step 7: Add the `dev:obs` scripts**

In `packages/server/package.json`, add to `scripts` (after `"dev"`):
```json
    "dev:obs": "DATABASE_URL=postgres://fiddle:fiddle@localhost:5432/fiddle FIDDLE_OTEL=1 OTEL_SERVICE_NAME=fiddle-server OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:5080/api/default OTEL_EXPORTER_OTLP_HEADERS=\"Authorization=Basic YWRtaW5AZmlkZGxlLmxvY2FsOmZpZGRsZS1kZXYtcGFzc3dvcmQ=\" tsx watch src/index.ts",
```

In root `package.json`, add to `scripts` (after `"dev"`):
```json
    "dev:obs:server": "npm run dev:obs -w @fiddle/server",
    "dev:obs": "npm-run-all --parallel dev:client dev:obs:server",
```

(`DATABASE_URL` is set inline so it wins over the committed `.env` per Node env-file precedence; `SUPABASE_JWKS_URL` still loads from `.env`, so real login works. The base64 is the non-secret local OpenObserve dev credential `admin@fiddle.local:fiddle-dev-password`.)

- [ ] **Step 8: Verify typecheck + the instrumented server boots and reports to OpenObserve**

Run:
```bash
npm run typecheck -w @fiddle/server
```
Expected: no errors.

Then, with the Docker stack from Task 1 up:
```bash
npm run dev:obs -w @fiddle/server
```
In another terminal, generate a request and check the span landed:
```bash
curl -s http://localhost:8787/api/sessions >/dev/null
sleep 12
curl -s -u 'admin@fiddle.local:fiddle-dev-password' \
  'http://localhost:5080/api/default/default/_search?type=traces' \
  -H 'content-type: application/json' \
  -d '{"query":{"sql":"SELECT service_name, name FROM default","start_time":0,"end_time":0}}' | head -c 400
```
Expected: OpenObserve responds with hits referencing `fiddle-server` and a `GET /api/sessions` span (exact JSON shape may vary; the point is `fiddle-server` traces exist). Alternatively confirm visually in the UI → Traces. Stop the server (Ctrl-C) when done.

- [ ] **Step 9: Commit**

```bash
git add packages/server/package.json package.json package-lock.json \
  packages/server/src/otel/sdk.ts packages/server/src/otel/sdk.test.ts \
  packages/server/src/index.ts
git commit -m "$(cat <<'EOF'
feat(obs): flag-gated OpenTelemetry bootstrap + dev:obs scripts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: DB instrumentation (spans + metrics + store wrappers)

**Files:**
- Create: `packages/server/src/otel/db.ts`, `packages/server/src/otel/db.test.ts`
- Modify: `packages/server/src/server.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/otel/db.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { withDbSpan, instrumentSessionStore, instrumentProfileStore } from './db.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { ProfileStore } from '../profile/ProfileStore.js';

describe('withDbSpan', () => {
  it('returns the wrapped result (no-op when no OTel provider is set)', async () => {
    const result = await withDbSpan('test.op', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates thrown errors', async () => {
    await expect(
      withDbSpan('test.op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('instrumentSessionStore', () => {
  it('delegates every method to the inner store unchanged', async () => {
    const inner: SessionStore = {
      create: vi.fn(async () => ({}) as never),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      getSnapshot: vi.fn(async () => null),
      saveSnapshot: vi.fn(async () => {}),
      updateMeta: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const store = instrumentSessionStore(inner);

    await store.list();
    await store.get('s1');
    await store.getSnapshot('s1');
    await store.saveSnapshot('s1', freshProject());
    await store.updateMeta('s1', { name: 'n' });
    await store.delete('s1');

    expect(inner.list).toHaveBeenCalledTimes(1);
    expect(inner.get).toHaveBeenCalledWith('s1');
    expect(inner.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(inner.delete).toHaveBeenCalledWith('s1');
  });
});

describe('instrumentProfileStore', () => {
  it('delegates getUsername and returns its value', async () => {
    const inner: ProfileStore = { getUsername: vi.fn(async () => 'neo') };
    const store = instrumentProfileStore(inner);
    expect(await store.getUsername('u1')).toBe('neo');
    expect(inner.getUsername).toHaveBeenCalledWith('u1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd packages/server && npx vitest run src/otel/db.test.ts
```
Expected: FAIL — cannot find module `./db.js`.

- [ ] **Step 3: Implement the DB instrumentation**

Create `packages/server/src/otel/db.ts`:

```ts
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import type { Project } from '@fiddle/shared';
import type { SessionStore } from '../session/SessionStore.js';
import type { ProfileStore } from '../profile/ProfileStore.js';
import { isOtelEnabled } from './sdk.js';

const TRACER = 'fiddle-db';

// Lazily created so they bind to the real MeterProvider (installed by
// startOtel) on first use. Without an SDK these are no-op instruments.
let callsInst: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;
let durInst: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | null = null;
let bytesInst: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | null = null;
function calls() {
  return (callsInst ??= metrics.getMeter(TRACER).createCounter('fiddle.db.calls'));
}
function duration() {
  return (durInst ??= metrics.getMeter(TRACER).createHistogram('fiddle.db.duration_ms', { unit: 'ms' }));
}
function blobBytes() {
  return (bytesInst ??= metrics.getMeter(TRACER).createHistogram('fiddle.db.blob_bytes', { unit: 'By' }));
}

// Serialized byte size — only computed when OTel is on (avoids stringifying the
// ~224 KB project on every snapshot op in prod).
function blob(value: unknown): number {
  if (!isOtelEnabled()) return 0;
  return Buffer.byteLength(JSON.stringify(value));
}

interface DbSpanOpts<T> {
  rowsOf?: (result: T) => number;
  sizeOf?: (result: T) => number; // bytes derived from the result
  inputBytes?: number; // bytes of the input payload (writes)
}

// Wrap one DB call: child span + duration/call metrics, plus optional row count
// and blob-byte size. A no-op tracer/meter (flag off) makes this nearly free.
export async function withDbSpan<T>(
  op: string,
  exec: () => Promise<T>,
  opts: DbSpanOpts<T> = {},
): Promise<T> {
  const tracer = trace.getTracer(TRACER);
  const start = performance.now();
  return tracer.startActiveSpan(`db ${op}`, async (span) => {
    span.setAttribute('db.op', op);
    try {
      const result = await exec();
      const ms = performance.now() - start;
      calls().add(1, { 'db.op': op });
      duration().record(ms, { 'db.op': op });
      span.setAttribute('db.duration_ms', ms);
      if (opts.rowsOf) span.setAttribute('db.rows', opts.rowsOf(result));
      if (isOtelEnabled()) {
        const bytes = opts.sizeOf ? opts.sizeOf(result) : opts.inputBytes ?? 0;
        if (bytes > 0) {
          span.setAttribute('db.blob_bytes', bytes);
          blobBytes().record(bytes, { 'db.op': op });
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Transparent wrapper: same SessionStore contract, every call instrumented.
// Applied to the in-memory and Postgres stores alike (no-op when flag off).
export function instrumentSessionStore(inner: SessionStore): SessionStore {
  return {
    create: (input) =>
      withDbSpan('sessions.create', () => inner.create(input), { inputBytes: blob(input.project) }),
    get: (id) => withDbSpan('sessions.get', () => inner.get(id), { rowsOf: (r) => (r ? 1 : 0) }),
    list: () => withDbSpan('sessions.list', () => inner.list(), { rowsOf: (r) => r.length }),
    getSnapshot: (id) =>
      withDbSpan('sessions.getSnapshot', () => inner.getSnapshot(id), {
        sizeOf: (r: Project | null) => (r ? blob(r) : 0),
      }),
    saveSnapshot: (id, project) =>
      withDbSpan('sessions.saveSnapshot', () => inner.saveSnapshot(id, project), {
        inputBytes: blob(project),
      }),
    updateMeta: (id, patch) => withDbSpan('sessions.updateMeta', () => inner.updateMeta(id, patch)),
    delete: (id) => withDbSpan('sessions.delete', () => inner.delete(id)),
  };
}

export function instrumentProfileStore(inner: ProfileStore): ProfileStore {
  return {
    getUsername: (userId) =>
      withDbSpan('profiles.getUsername', () => inner.getUsername(userId), {
        rowsOf: (r) => (r ? 1 : 0),
      }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd packages/server && npx vitest run src/otel/db.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the wrappers into `server.ts`**

Edit `packages/server/src/server.ts`.

Add the import (after the `sessionsRoute` import on line 21):
```ts
import { instrumentSessionStore, instrumentProfileStore } from './otel/db.js';
```

Replace the store construction block (currently lines 44-49):
```ts
  const profiles: ProfileStore = instrumentProfileStore(
    sql ? new PostgresProfileStore(sql) : new InMemoryProfileStore(),
  );
  const sessions: SessionStore = instrumentSessionStore(
    sql ? new PostgresSessionStore(sql) : new InMemorySessionStore(),
  );
```

- [ ] **Step 6: Verify the existing server suite still passes (wrappers are transparent)**

Run:
```bash
cd packages/server && npx vitest run
```
Expected: PASS — all existing tests green (the wrappers delegate identically; OTel is off in tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/otel/db.ts packages/server/src/otel/db.test.ts packages/server/src/server.ts
git commit -m "$(cat <<'EOF'
feat(obs): DB spans + metrics via transparent store wrappers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: WS frame instrumentation (at the route boundary)

**Files:**
- Create: `packages/server/src/otel/ws.ts`, `packages/server/src/otel/ws.test.ts`
- Modify: `packages/server/src/routes/ws.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/otel/ws.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { frameType, recordWsFrame } from './ws.js';

describe('frameType', () => {
  it('extracts the type field from a parsed frame', () => {
    expect(frameType({ type: 'set', path: ['bpm'] })).toBe('set');
  });
  it('returns "unknown" for null / typeless / non-object frames', () => {
    expect(frameType(null)).toBe('unknown');
    expect(frameType({})).toBe('unknown');
    expect(frameType(42)).toBe('unknown');
  });
});

describe('recordWsFrame', () => {
  it('does not throw without an OTel provider', () => {
    expect(() => recordWsFrame('in', 'set', 128)).not.toThrow();
    expect(() => recordWsFrame('out', 'snapshot', 224000)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd packages/server && npx vitest run src/otel/ws.test.ts
```
Expected: FAIL — cannot find module `./ws.js`.

- [ ] **Step 3: Implement the WS recorders**

Create `packages/server/src/otel/ws.ts`:

```ts
import { metrics } from '@opentelemetry/api';

const METER = 'fiddle-ws';

let framesInst: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;
let frameBytesInst: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | null = null;
function frames() {
  return (framesInst ??= metrics.getMeter(METER).createCounter('fiddle.ws.frames'));
}
function frameBytes() {
  return (frameBytesInst ??= metrics.getMeter(METER).createHistogram('fiddle.ws.frame_bytes', { unit: 'By' }));
}

// 'in' = received from a client, 'out' = sent to a client. Counted and sized by
// message type so a chatty path (e.g. per-keystroke 'set' ops, or 224 KB
// 'snapshot' fan-out) is visible in OpenObserve. No-op without an SDK.
export function recordWsFrame(dir: 'in' | 'out', type: string, bytes: number): void {
  frames().add(1, { 'ws.dir': dir, 'ws.type': type });
  frameBytes().record(bytes, { 'ws.dir': dir, 'ws.type': type });
}

// Safe label extraction from an already-parsed (or null) inbound frame.
export function frameType(parsed: unknown): string {
  if (parsed && typeof parsed === 'object' && 'type' in parsed) {
    const t = (parsed as { type: unknown }).type;
    if (typeof t === 'string') return t;
  }
  return 'unknown';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd packages/server && npx vitest run src/otel/ws.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Wire recorders into `ws.ts`**

Edit `packages/server/src/routes/ws.ts`.

Add the import (after the existing imports, near line 23):
```ts
import { recordWsFrame, frameType } from '../otel/ws.js';
```

Replace `adaptSocket` (lines 34-46) so outbound frames are sized once and recorded:
```ts
function adaptSocket(ws: WebSocket): SocketLike {
  return {
    send(msg: ServerMessage) {
      const text = JSON.stringify(msg);
      recordWsFrame('out', msg.type, Buffer.byteLength(text));
      ws.send(text);
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
    get readyState() {
      return ws.readyState;
    },
  };
}
```

Replace the inbound `socket.on('message', ...)` handler (lines 72-80) so inbound frames are recorded:
```ts
    socket.on('message', (raw: RawData) => {
      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      recordWsFrame('in', frameType(parsed), Buffer.byteLength(text));
      handler.onMessage(parsed).catch((err) => app.log.error({ err }, 'ws onMessage'));
    });
```

(The durable session load during hello — `sessions.get` + `sessions.getSnapshot` — is already captured by the Task 3 store wrappers, so no extra timing is needed here.)

- [ ] **Step 6: Verify the existing server suite still passes**

Run:
```bash
cd packages/server && npx vitest run
```
Expected: PASS — all tests green (recorders are no-ops; behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/otel/ws.ts packages/server/src/otel/ws.test.ts packages/server/src/routes/ws.ts
git commit -m "$(cat <<'EOF'
feat(obs): WS frame count + bytes metrics at the route boundary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Domain-log bridge (pino + OTel logs)

**Files:**
- Create: `packages/server/src/otel/log.ts`, `packages/server/src/otel/log.test.ts`
- Modify: `packages/server/src/server.ts`, `packages/server/src/routes/ws.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/otel/log.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeLog } from './log.js';

describe('makeLog', () => {
  it('forwards message + fields to the Fastify pino logger', () => {
    const info = vi.fn();
    const fakeApp = { log: { info } } as never;
    const log = makeLog(fakeApp);

    log('guest session pruned on empty', { roomId: 'r1' });

    expect(info).toHaveBeenCalledWith({ roomId: 'r1' }, 'guest session pruned on empty');
  });

  it('uses an empty object when no fields are given and does not throw', () => {
    const info = vi.fn();
    const fakeApp = { log: { info } } as never;
    const log = makeLog(fakeApp);

    expect(() => log('server up')).not.toThrow();
    expect(info).toHaveBeenCalledWith({}, 'server up');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd packages/server && npx vitest run src/otel/log.test.ts
```
Expected: FAIL — cannot find module `./log.js`.

- [ ] **Step 3: Implement the log bridge**

Create `packages/server/src/otel/log.ts`:

```ts
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { FastifyInstance } from 'fastify';
import type { Log } from '../sync/ConnectionHandler.js';
import { isOtelEnabled } from './sdk.js';

// Builds the Log callback the SessionSync + ws route use. Always writes to the
// existing pino logger; when OTel is on, also emits a trace-correlated OTel log
// record so domain events ("guest session pruned", "session flush failed",
// "client live") show up in OpenObserve alongside traces. No-op emit otherwise.
export function makeLog(app: FastifyInstance): Log {
  return (message, ctx) => {
    app.log.info(ctx ?? {}, message);
    if (!isOtelEnabled()) return;
    logs.getLogger('fiddle-server').emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: message,
      attributes: ctx,
    });
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd packages/server && npx vitest run src/otel/log.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Use `makeLog` in `server.ts`**

Edit `packages/server/src/server.ts`.

Add the import (after the Task 3 db import):
```ts
import { makeLog } from './otel/log.js';
```

Add a shared log right after `const app = Fastify(...)` (line 24):
```ts
  const log = makeLog(app);
```

Replace the `SessionSync` construction (lines 51-55) to use it:
```ts
  const sessionSync = new SessionSync(store, sessions, log);
```

Update the `wsRoute` registration (line 75) to pass `log`:
```ts
  app.register(async (a) => wsRoute(a, { store, pool, verify, profiles, sessionSync, loadSession, log }));
```

- [ ] **Step 6: Thread `log` through `ws.ts`**

Edit `packages/server/src/routes/ws.ts`.

Add `Log` to the imports (near line 23):
```ts
import type { Log } from '../sync/ConnectionHandler.js';
```

Add `log` to the `Deps` interface (inside the block at lines 25-32):
```ts
  log: Log;
```

Replace the two inline handler-log lambdas with `deps.log`. The `ConnectionHandler` construction (lines 58-67) — change its log argument:
```ts
    const handler = new ConnectionHandler(
      roomId,
      adapted,
      deps.store,
      deps.pool,
      deps.log,
      deps.verify,
      deps.profiles,
      deps.loadSession,
    );
```

- [ ] **Step 7: Verify typecheck + full server suite**

Run:
```bash
npm run typecheck -w @fiddle/server && cd packages/server && npx vitest run
```
Expected: typecheck clean; all tests PASS. (`server.test.ts` builds the server via `buildServer()`, which now constructs `makeLog` and the wrapped stores — all transparent with the flag off.)

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/otel/log.ts packages/server/src/otel/log.test.ts \
  packages/server/src/server.ts packages/server/src/routes/ws.ts
git commit -m "$(cat <<'EOF'
feat(obs): domain-log bridge to OTel logs (pino + OTLP)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Runbook + full verification

**Files:**
- Create: `docs/LOCAL_OBSERVABILITY.md`

- [ ] **Step 1: Write the runbook**

Create `docs/LOCAL_OBSERVABILITY.md`:

```markdown
# Local Observability Runbook

A disposable local environment for studying Fiddle's network + DB interactions
without touching the production Supabase DB. Postgres + OpenObserve run in
Docker; the server is instrumented with OpenTelemetry behind the `FIDDLE_OTEL`
flag (off everywhere else, so production is never instrumented).

## Start

```bash
docker compose up -d                 # postgres :5432 + openobserve :5080
npm run dev:obs                      # client (:5173) + instrumented server (:8787)
```

- App:        http://localhost:5173
- OpenObserve: http://localhost:5080  (login: admin@fiddle.local / fiddle-dev-password)

The server uses the **local** Postgres but the **real** Supabase JWKS, so Google
login works and logged-in sessions persist locally (guest sessions self-prune —
log in to reproduce the real lobby workload).

## Exercise + analyze

1. Log in, create/join/edit sessions, watch the lobby, leave — whatever you want
   to measure.
2. In OpenObserve:
   - **Traces** — each HTTP request and its child `db <op>` spans (duration,
     `db.rows`, `db.blob_bytes`); WS-driven DB ops appear as their own spans.
   - **Metrics** — `fiddle.db.calls` / `fiddle.db.duration_ms` /
     `fiddle.db.blob_bytes`, `fiddle.ws.frames` / `fiddle.ws.frame_bytes`
     (grouped by `db.op`, `ws.dir`, `ws.type`).
   - **Logs** — domain events (`client live`, `guest session pruned on empty`,
     `session flush failed`), trace-correlated.

## Stop / reset

```bash
docker compose down            # stop; keeps data volumes
docker compose down -v         # stop and wipe the local DB + telemetry
```

## Notes

- Nothing here runs in production: `FIDDLE_OTEL` is set only by `dev:obs`, and the
  OTLP exporter targets localhost. With the flag off the OTel API hands out no-op
  tracers/meters, so the instrumentation is inert.
- The local schema (`packages/server/db/local-init.sql`) drops the Supabase
  auth.users FK / RLS / signup trigger; it is NOT the production schema.
```

- [ ] **Step 2: Run the full gate**

Run from the repo root:
```bash
npm run typecheck && npm test && npm run build
```
Expected: all three green.

- [ ] **Step 3: End-to-end manual verification**

With the stack up (`docker compose up -d`) and `npm run dev:obs` running:
1. Open http://localhost:5173, log in with Google, create a session, edit a few
   steps/knobs, open the lobby, then leave the session.
2. In OpenObserve confirm: `fiddle-server` traces with `db sessions.*` child
   spans; `fiddle.ws.frames` metrics split by `ws.type` (expect `set`,
   `snapshot`, `presence.update`, etc.); domain logs present.
3. Confirm no errors in the server console or the browser console.
4. **Cleanup (AGENTS.md):** close the browser tab, stop `dev:obs` (Ctrl-C), and
   `docker compose down` when finished.

- [ ] **Step 4: Commit**

```bash
git add docs/LOCAL_OBSERVABILITY.md
git commit -m "$(cat <<'EOF'
docs(obs): local observability runbook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Local Docker Postgres + auth-decoupled schema → Task 1. ✅
- OpenObserve container + UI → Task 1. ✅
- Flag-gated OTel bootstrap, loaded before Fastify instance, localhost-only, prod off → Task 2. ✅
- HTTP layer (Fastify auto-instrumentation, diagnostics-channel, no IITM) → Task 2 (`@fastify/otel`). ✅
- DB layer spans + metrics + blob bytes → Task 3. ✅
- WS layer frame counts/bytes by type; durable load via store wrappers; ConnectionHandler untouched → Task 4. ✅
- Logs bridged to OTLP → Task 5. ✅
- Real login via prod JWKS, local DATABASE_URL override → Task 2 (`dev:obs`) + runbook. ✅
- Testing: pure helpers unit-tested, gate green with flag off, stores behave identically → Tasks 2–6. ✅
- Runbook → Task 6. ✅
- Deferred items (symptom diagnosis, prod OTel, browser RUM, pooler reproduction) → out of scope, not in any task. ✅

**Placeholder scan:** No TBD/TODO; every code/command step shows concrete content. The one documented ambiguity (`@fastify/otel` default vs named import) carries an explicit in-code fallback note, not a blank.

**Type consistency:** `isOtelEnabled` / `startOtel` / `shutdownOtel` (sdk.ts) used consistently in index.ts and db.ts/log.ts. `withDbSpan` / `instrumentSessionStore` / `instrumentProfileStore` (db.ts) match the `SessionStore` (7 methods) and `ProfileStore` (`getUsername`) interfaces verified in the repo. `recordWsFrame(dir, type, bytes)` / `frameType(parsed)` (ws.ts) match the ws.ts call sites. `makeLog(app): Log` matches the `Log = (message, ctx?) => void` type and `SessionSync` / `ConnectionHandler` constructor arity. `wsRoute` `Deps` gains `log: Log`, set by server.ts.
