# AGENTS.md — Fiddle Synth

Guidance for AI agents and contributors working in this repo. Read this first,
then the canonical docs linked below before touching the relevant subsystem.

## What this is

A browser-based **4-track step sequencer + synthesizer** (Vue 3 + TypeScript +
Vite + Web Audio API). Each track runs one of five sound engines (Synth, Kick,
Hat, Snare, Clap) with independent loop lengths (polymeter). All editable state
lives in a `Project` object auto-saved to `localStorage`.

A **Fastify WebSocket sync server** powers live multi-user collaboration:
project state is synced over WS (per-field last-write-wins) while audio renders
locally in each browser. Deployed with the client on Vercel and the server on
Render. Optional Supabase Google sign-in layers on top without changing the
guest flow.

## Repo layout

npm **workspaces monorepo** under `packages/`:

- `@fiddle/client` — the Vue/Vite app (UI, audio engines, sequencer, sync client).
- `@fiddle/server` — Fastify WebSocket sync server + HTTP sessions API.
- `@fiddle/shared` — project schema, sync-protocol types, and helpers that must
  compile in both Node and the browser.

`docs/` holds the canonical reference docs. `docs/superpowers/` holds specs and
implementation plans.

## Commands

Run from the repo root; they fan out to workspaces via `-w`.

- `npm run dev` — run client (:5173) and server (:8787) in parallel. Vite
  proxies `/ws` and `/api` to the server in dev.
- `npm run typecheck` — typecheck all workspaces.
- `npm test` — unit/integration tests across all workspaces (Vitest).
  **Excludes** `*.e2e.test.ts`.
- `npm run test:e2e:server` — the real-socket server protocol e2e suite.
- `npm run build` — build client then server.

**Gate before any merge:** `npm run typecheck && npm test && npm run build` must
be green.

## Conventions

- **Testing:** test logic, composables, and pure helpers. Do **not** mount
  `.vue` files in tests.
- **TypeScript:** `strict` is on, plus `noUnusedLocals` / `noUnusedParameters`.
  `exactOptionalPropertyTypes` is **off**.
- **Commits:** commit only the files relevant to the change — never `git add -A`
  / `git add .`. End commit messages with the project's `Co-Authored-By` trailer.
- **Merges are forbidden without direct user instruction:** never merge a branch
  on your own initiative. Do the work on a feature branch and stop there; only
  merge when the user explicitly tells you to. Keep feature branches as-is unless
  told otherwise.
- **Browser verification:** before telling the user that work is done, verify
  the result in the browser using the Playwright MCP — drive the running dev app
  (`npm run dev`), exercise the changed flow, and confirm there are no console
  errors. Report what you observed. This does not replace the user's own
  visual/audio sign-off, but never report work as done unverified.
- **Sync state:** WS sync watchers must use `flush: 'sync'` — the
  `applyingFromNetwork` guard only works synchronously. Read
  `docs/ARCHITECTURE.md` §15 before adding syncable fields.

## Canonical docs

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — load-bearing. §3 (SoundEngine
  contract), §6 (`useSynth` singleton), §14–§16 (server/sync/deploy), and the
  Decisions appendix (D1–D8, D15). Read before touching the audio engine,
  sequencer, or `useSynth`.
- [`docs/CODE_REVIEW.md`](./docs/CODE_REVIEW.md) — findings list with resolution
  status; source of truth when it conflicts with other docs.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — planned features and the Supabase
  persistence pivot.
- [`docs/BACKLOG.md`](./docs/BACKLOG.md) — known bugs and smaller tasks.
