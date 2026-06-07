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

- App:         http://localhost:5173
- OpenObserve: http://localhost:5080  (login: admin@fiddle.local / Fiddle-Dev-1!)

The server uses the **local** Postgres but the **real** Supabase JWKS, so Google
login works and logged-in sessions persist locally (guest sessions self-prune —
log in to reproduce the real lobby workload).

> OpenObserve enforces an 8–128 char password (upper/lower/digit/special); that
> is why the dev credential is `Fiddle-Dev-1!`. It is a non-secret local value,
> also set in `docker-compose.yml` and the `dev:obs` OTLP auth header.

## Exercise + analyze

1. Log in, create/join/edit sessions, watch the lobby, leave — whatever you want
   to measure.
2. In OpenObserve:
   - **Traces** — each HTTP request and its child `db <op>` spans (duration,
     `db.rows`, `db.blob_bytes`); WS-driven DB ops appear as their own spans.
   - **Metrics** — `fiddle.db.calls` / `fiddle.db.duration_ms` /
     `fiddle.db.blob_bytes` (grouped by `db.op`, and by `error` so failed calls
     — e.g. Supabase timeouts — are counted and timed too), plus
     `fiddle.ws.frames` / `fiddle.ws.frame_bytes` (grouped by `ws.dir`,
     `ws.type`).
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
