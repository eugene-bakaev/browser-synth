# Local Dev Environment + Exhaustive Observability — Design

**Date:** 2026-06-06
**Status:** Approved (brainstorming) — pending spec review, then implementation plan.

## Goal

Stand up a **faithful local development environment** (Dockerized Postgres + real
Google login via the production JWKS) and instrument the server with
**OpenTelemetry** (traces + metrics + logs) exported to a **local OpenObserve**
instance, all behind a flag so production is untouched. The purpose is to make
the server's **network and DB interactions fully visible** during manual testing,
so we can later analyze them and find non-optimal Supabase usage.

This slice delivers the *instrument*. Diagnosing specific symptoms and changing
the DB-interaction patterns is **explicitly deferred** to a follow-up — we build
the lens first, then look through it.

## Scope

**In scope:**

- A local Postgres in Docker with an **auth-decoupled schema** (sessions +
  session_snapshots + profiles, minus the Supabase auth couplings) so a **real
  login** persists a session under the user's real UUID without touching the prod
  DB.
- An OpenObserve container receiving OTLP and serving the single-pane UI.
- OpenTelemetry bootstrap in `@fiddle/server`, **gated behind an explicit flag**
  (`FIDDLE_OTEL`), exporting nothing when unset (prod default).
- Instrumentation across four layers:
  - **HTTP** — Fastify/HTTP auto-instrumentation (one span per request).
  - **DB** — manual spans + metrics around the Postgres store methods (op,
    duration, rows, serialized blob bytes).
  - **WS sync** — manual spans + metrics in `ConnectionHandler` /
    `wsRoute` (hello, durable-load, inbound ops, outbound broadcasts,
    disconnect → flush).
  - **Logs** — bridge the existing pino logger into OTLP logs (trace-correlated),
    still echoed to console.
- A short runbook (`docs/` or `README` section) for starting the env.

**Out of scope (deferred):**

- Diagnosing the actual Supabase symptom and changing any DB-interaction pattern
  (its own follow-up, informed by the data this slice produces).
- Production OpenTelemetry / exporting telemetry from Render.
- Browser-side RUM (client OTel SDK). The server sees every request and WS
  message, which covers all DB-relevant traffic; client RUM can be added later.
- Reproducing Supabase's **transaction pooler** (port 6543) locally — no local
  stack reproduces it, and it isn't needed to measure our query patterns.
- Load testing / automated traffic generation. Manual testing drives the data.

## Context (today's DB-interaction surface)

The server is the only DB client (browser never touches Postgres directly). A
single `postgres()` pool backs both stores when `DATABASE_URL` is set
(`server.ts:43`), tuned for the Supabase txn pooler (`postgresOptions.ts`:
`prepare:false`, `max:10`, `idle_timeout:20`, `max_lifetime:300`,
`connect_timeout:10`).

**Reads**

- `GET /api/sessions` (lobby) → `sessions.list()` = `select * from sessions
  order by updated_at desc` — **no `LIMIT`, returns every session including the
  `settings` jsonb**. Fires on lobby open + every 30s poll per viewer (already
  paused when the tab is hidden).
- `GET /api/sessions/:id` → single-row `get` (studio settings panel, ownership).
- WS connect → `loadSession` = `get` + `getSnapshot` (the full project blob,
  ~224 KB per `ConnectionHandler.ts:55`), bounded by `SESSION_LOAD_TIMEOUT_MS`
  (8s).

**Writes**

- `saveSnapshot` writes the **entire ~224 KB project blob** on the 60s dirty
  sweep (`SessionSync.FLUSH_INTERVAL_MS`), **plus on every disconnect**
  (`handleDisconnect` → `flushRoom`, unconditional — even with no edits since the
  last flush), plus on graceful shutdown.
- `POST /api/sessions` = 2 inserts (sessions + session_snapshots).
- `PATCH` = `get` + `updateMeta`. `DELETE` (owner delete + guest self-prune).

**Lobby filtering** (`lobby.ts`): guest-owned rooms are hidden when no live
members, and `SessionSync.handleDisconnect` deletes the guest row on empty.
Only **logged-in-owned** sessions persist and always list — which is *why* the
local env must support real login (a guest-only env can't reproduce the
workload).

These are the candidate "non-optimal interactions" the instrumentation must make
measurable; the analysis is deferred.

## Local environment

### Compose services

Replace the current `docker-compose.yml` (it references a non-existent
`packages/server/Dockerfile`) with a dev stack:

- **`postgres`** — `postgres:16`, exposed on `localhost:5432`, with a named
  volume and an init script mounted at `/docker-entrypoint-initdb.d/`.
- **`openobserve`** — single container, OTLP ingest enabled, UI exposed locally
  (default `:5080`), with dev credentials baked into compose env and a named data
  volume.

The server runs on the **host** via `npm run dev` (simplest for iterating on
instrumentation), pointed at the compose Postgres and OpenObserve. (Running the
server in compose too is possible later but not required for this slice.)

### Local schema (`db/local-init.sql`, dev-only)

The two prod migrations with the Supabase couplings removed:

- `sessions` + `session_snapshots` as in `0002_sessions.sql`, but **drop the
  `owner_user_id → auth.users` FK** (`owner_user_id` stays a plain nullable
  `uuid`). This lets a real prod login — whose `userId` is a Supabase UUID with
  no local `auth.users` row — insert and persist a session.
- `profiles` as in `0001_profiles.sql`, but **no RLS, no `auth.uid()` policies,
  no `auth.users` FK, no signup trigger**. RLS guards only the browser's direct
  access, which never happens; the privileged server is the sole client.
  `PostgresProfileStore.getUsername` tolerates a missing row (falls back to the
  token's Google name), so the table can stay empty.

Real login keeps working because verification is **JWKS-based and read-only**
(`verifyToken.ts`): the local server keeps the real `SUPABASE_JWKS_URL`, only
`DATABASE_URL` is repointed at local Postgres.

### Env wiring

A local server env (gitignored) sets `DATABASE_URL=<local pg>`, keeps the real
`SUPABASE_JWKS_URL`, and sets `FIDDLE_OTEL=1` plus the OTLP endpoint/credentials
for OpenObserve. Node env-file semantics mean an exported `DATABASE_URL` takes
precedence over the committed `.env`, so the override is clean.

## Instrumentation (OpenTelemetry)

### Gating & production safety (load-bearing)

- A bootstrap module (`otel.ts`) initializes the OTel NodeSDK **only when
  `FIDDLE_OTEL` is set**. Unset → the SDK never starts, no exporter is created,
  nothing is sent, and the instrumentation wrappers fall through to no-ops. Zero
  overhead and zero external sends in prod (Render never sets the flag).
- It is loaded **first**, before `buildServer`, so auto-instrumentation can patch
  modules before they're imported. (ESM ordering handled in the plan — likely a
  guarded dynamic `import()` at the top of `index.ts` or a `--import` hook.)
- The exporter targets **localhost only**. There is no code path that ships
  telemetry off the machine.

### HTTP layer

`@opentelemetry/instrumentation-fastify` + `@opentelemetry/instrumentation-http`
→ a span per request with method, route, status, duration, and payload size.
Captures the lobby poll cadence and the create/patch/get/delete traffic
automatically.

### DB layer

porsager `postgres` is **not** covered by official OTel auto-instrumentation
(`@opentelemetry/instrumentation-pg` patches `node-postgres` only). Since we own
the stores, wrap `PostgresSessionStore` and `PostgresProfileStore` methods with a
thin span+metric helper that records, per call:

- `db.op` (e.g. `sessions.list`, `sessions.getSnapshot`, `sessions.saveSnapshot`,
  `profiles.getUsername`), duration, rows returned/affected, and **serialized
  blob bytes** for snapshot reads/writes.

Metrics: a histogram of duration and a counter of calls, both keyed by `db.op`;
a histogram of blob bytes for snapshot ops. (Optionally enable postgres.js's
`debug` hook to also capture raw SQL text — decided in the plan.)

### WS sync layer

Manual spans + metrics at the `wsRoute` / `ConnectionHandler` seam:

- connection open + hello (user vs guest; **durable-load duration** for
  `loadSession`), inbound op count / path / bytes, outbound broadcast count /
  bytes, disconnect → `handleDisconnect` flush (duration + blob bytes).

This is the chattiest layer and the most likely home of non-optimal interactions
(e.g. a full ~224 KB snapshot write on every disconnect).

### Logs

Bridge pino → OTLP logs (e.g. `@opentelemetry/instrumentation-pino`) so existing
`app.log` lines land in OpenObserve, trace-correlated, while still printing to
the console. No new logging API to learn.

## Data flow

```
user action
  → HTTP request span (Fastify auto)            ─┐
      → DB child span(s) (store wrapper)          ├─ OTLP → OpenObserve
  → WS frame span (ConnectionHandler)            ─┤      (traces + metrics + logs,
      → DB child span(s) (loadSession / flush)   ─┘       correlated, single UI)
metrics (counters/histograms per op) ────────────┘
```

In OpenObserve: traces show the request→DB chain per action; metrics dashboards
show per-op rate / latency / payload size over the session ("the rollup");
logs are searchable and linked to traces.

## Testing

- The instrumentation wrappers contain pure, testable logic (byte-sizing,
  op-name derivation, no-op-when-disabled). Unit-test those per the repo
  convention (test logic/helpers; don't mount `.vue`; the server suite is
  Vitest).
- The OTel SDK and exporters are **not** exercised in CI — they're dev-only and
  flag-off by default. The gate (`npm run typecheck && npm test && npm run
  build`) must stay green with the flag **off**, and the instrumented stores must
  behave identically to today when telemetry is disabled.
- Manual verification: bring up compose, run the server with the flag on, log in,
  create/join/edit a session in the browser, and confirm traces/metrics/logs
  appear in OpenObserve with no console errors. Close the browser tab and stop
  the stack afterward (AGENTS.md).

## Risks & tradeoffs

- **Extra deps + a container vs. a JSONL file.** Chosen deliberately: a JSONL +
  jq script is lighter but gives no correlation or UI. OpenObserve is the lightest
  real "local Datadog" and the user wants that view.
- **OTel ESM bootstrap ordering** must run before instrumented modules load, or
  auto-instrumentation silently no-ops. Verified during manual bring-up.
- **postgres.js needs manual DB spans** (no official auto-instrumentation). We
  own the stores, so this is clean — but a query that bypasses the stores
  wouldn't be traced (none exist today).
- **Local env is not byte-identical to prod**: no transaction pooler, no real
  `auth.users`. Accepted — we're measuring *our* query shapes/frequency/payloads,
  which are identical regardless of the pooler.
- **Flag discipline.** The single most important invariant is that prod stays
  fully un-instrumented. Default-off + localhost-only exporter + no Render env
  enforces it; the plan adds a test asserting disabled = no-op.

## Open items for the plan

- Exact OTel package set + versions (SDK, Fastify/HTTP/pino instrumentations,
  OTLP HTTP exporter), pinned via context7.
- ESM bootstrap mechanism (guarded dynamic import vs. `node --import`).
- OpenObserve OTLP endpoint + auth-header/stream wiring from compose.
- `.gitignore` additions (local server env, OpenObserve/Postgres volumes if
  bind-mounted, any tee'd log file).
- Whether to also enable postgres.js `debug` for raw SQL text.
