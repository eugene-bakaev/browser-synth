# Backend Scaffolding Design

**Date:** 2026-05-26
**Branch (planned):** `feature/backend-scaffolding`
**Base:** `main` at the most recent merge commit

## Goal

Stand up the surface of a backend service alongside the existing Vue/Vite client, so future work on real-time multi-user sync (WebSocket-relayed project state) has a place to land. The scaffold is deliberately empty of sync logic: a Fastify HTTP+WS server with a health check and a hello-world WS endpoint, packaged in a multi-stage Docker image, with the client untouched in behavior but relocated into an npm-workspaces monorepo. The existing Vercel deploy of the client must continue to work without dashboard intervention.

This spec is **infrastructure only**. The sync protocol, room model, presence, authentication, and any client-side WebSocket integration are out of scope and will be designed in their own spec/plan cycles.

## Context

The Fiddle Synth project has been built so far as a single-package client app at the repo root (Vue 3 + TS + Vite + Vitest, currently 182 tests passing on `main`). The long-term direction — captured in the [[multi-user-playground-goal]] memory — is to turn it into a 2-user (initially) collaborative jamming playground where audio remains local but project state synchronizes over WebSockets. The user has decided:

- **Two concurrent users** for the initial target.
- **Render.com** as the production host for the WebSocket server.
- **No authentication** in the initial iteration (anonymous link-share semantics).
- **Audio is purely local** on each peer; only project state crosses the wire.

The sync mechanism itself (CRDT vs JSON-Patch vs event log) is **deferred** — it will be brainstormed and specced in a follow-up. This spec exists so that when that brainstorm happens, the repo layout, build, and deploy story are already in place and the design work can focus on protocol rather than infrastructure.

## Repo layout

After the scaffold lands:

```
browser-synth/
├── package.json                  # root: workspaces config + run-all scripts
├── tsconfig.base.json            # shared compiler options
├── vercel.json                   # config-as-code for the Vercel client deploy
├── docker-compose.yml            # local dev: brings up the server container
├── docs/                         # unchanged; stays at root
├── packages/
│   ├── client/                   # the existing Vue app, MOVED here unchanged
│   │   ├── package.json          # name: "@fiddle/client"
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   └── src/                  # exactly what is in src/ today
│   ├── server/                   # NEW — Fastify + ws scaffold only
│   │   ├── package.json          # name: "@fiddle/server"
│   │   ├── tsconfig.json
│   │   ├── Dockerfile            # multi-stage builder → node:22-alpine runtime
│   │   ├── .dockerignore
│   │   └── src/
│   │       ├── index.ts          # boot entrypoint
│   │       ├── server.ts         # buildServer() factory (testable)
│   │       ├── server.test.ts    # one smoke test (Fastify .inject /health)
│   │       └── routes/
│   │           ├── health.ts     # GET /health → 200 { ok: true }
│   │           └── ws.ts         # /ws — placeholder, sends "hello", logs messages
│   └── shared/                   # NEW — types only, zero runtime deps
│       ├── package.json          # name: "@fiddle/shared"
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts          # public re-exports
│           └── project-types.ts  # verbatim copy of current src/project/types.ts
```

### Ownership and rationale

- **`packages/client`** — the existing app, content unchanged. Only its location moves. The internal imports stay the same; the *only* code change is switching the client's own references to `Project` / `ProjectTrack` from the local `./project/types` to `@fiddle/shared`, so the server has a name for the doc it will eventually relay.
- **`packages/server`** — Fastify 5 with `@fastify/websocket` 11, written in TS, compiled with `tsc` (not Vite — Vite is overkill on the server). Two routes only: `GET /health` and a `/ws` upgrade handler that does nothing useful yet. No sync logic, no rooms, no protocol.
- **`packages/shared`** — types-only package. No build step; both client (via Vite's workspace handling) and server (via `tsc` path resolution) consume the `.ts` source directly. For this scaffold it contains the project type definitions; future sync-protocol types will land here too.

## Vercel deploy strategy

The existing Vercel project auto-detects Vite from the root `package.json`. After moving the client to `packages/client/`, that auto-detection breaks. To prevent the deploy from regressing, **a `vercel.json` is added at the repo root as part of this scaffold PR**, codifying the deploy config:

```json
{
  "framework": "vite",
  "installCommand": "npm install",
  "buildCommand": "npm run build -w @fiddle/client",
  "outputDirectory": "packages/client/dist"
}
```

- Install runs at the repo root so npm sees the workspaces declaration and installs all workspaces correctly.
- Build runs only the client workspace.
- Output path tells Vercel where the static assets land.
- No "Root Directory" dashboard change required; the dashboard setting stays at the repo root.

**Verification:** Before merging the scaffold PR to `main`, the branch must be pushed and a Vercel preview deploy confirmed green (the preview URL loads the app and the synth functions). This is non-negotiable.

The server is **not** deployed by Vercel; Render handles it via Docker (configured in a follow-up PR).

## Server scaffold contents

### `packages/server/package.json`

```json
{
  "name": "@fiddle/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/websocket": "^11.0.0",
    "@fiddle/shared": "*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.4.0",
    "vitest": "^4.1.7",
    "@types/node": "^22.0.0"
  }
}
```

### `packages/server/src/server.ts`

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { healthRoute } from './routes/health.js';
import { wsRoute } from './routes/ws.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(websocket);
  app.register(healthRoute);
  app.register(wsRoute);
  return app;
}
```

Factory pattern so tests can instantiate the app without binding a port.

### `packages/server/src/index.ts`

```ts
import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildServer();
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

### `packages/server/src/routes/health.ts`

```ts
import type { FastifyInstance } from 'fastify';

export async function healthRoute(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }));
}
```

### `packages/server/src/routes/ws.ts`

```ts
import type { FastifyInstance } from 'fastify';

export async function wsRoute(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket) => {
    app.log.info('ws client connected');
    socket.send(JSON.stringify({ type: 'hello' }));
    socket.on('message', (raw) => {
      app.log.info({ raw: raw.toString() }, 'ws message');
    });
    socket.on('close', () => app.log.info('ws client disconnected'));
  });
}
```

### `packages/server/src/server.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';

describe('server', () => {
  it('serves /health', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
```

`app.inject()` is Fastify's built-in HTTP simulator, so no real port binding is needed in tests.

## Shared package contents

### `packages/shared/package.json`

```json
{
  "name": "@fiddle/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

### `packages/shared/src/index.ts`

Re-exports everything the current `src/project/types.ts` exports — same names, same shapes:

```ts
export type {
  Project,
  ProjectTrack,
  ProjectMeta,
  TrackMixer,
  EngineParamsMap,
  EngineType,
  // ...every other type currently exported from src/project/types.ts
} from './project-types.js';
```

The implementation step is "list every `export type` symbol from the current file and mirror it here," not a free-form decision.

### `packages/shared/src/project-types.ts`

Byte-for-byte copy of the current `src/project/types.ts`. The client then deletes its local copy and updates all imports of these types to come from `@fiddle/shared`. No type definitions change in this PR.

## Docker

### `packages/server/Dockerfile` (multi-stage)

```dockerfile
# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN npm ci --workspace=@fiddle/server --include-workspace-root

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY tsconfig.base.json ./
RUN npm run build -w @fiddle/server

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN npm ci --omit=dev --workspace=@fiddle/server --include-workspace-root

COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/shared ./packages/shared

EXPOSE 8787
CMD ["node", "packages/server/dist/index.js"]
```

### `packages/server/.dockerignore`

```
node_modules
dist
.vscode
.git
*.log
packages/client
docs
```

Prevents the client and docs trees from bloating the Docker build context.

### `docker-compose.yml` (root, dev-focused)

```yaml
services:
  server:
    build:
      context: .
      dockerfile: packages/server/Dockerfile
      target: builder
    command: npm run dev -w @fiddle/server
    working_dir: /app
    volumes:
      - ./packages/server/src:/app/packages/server/src
      - ./packages/shared/src:/app/packages/shared/src
    ports:
      - "8787:8787"
    environment:
      PORT: "8787"
      HOST: "0.0.0.0"
```

Builds the `builder` target so dev deps (`tsx`) are available; mounts `src` directories for live reload. Production deploys (Render) build the full multi-stage image to the `runtime` target.

## Root configuration

### Root `package.json`

```json
{
  "name": "browser-synth",
  "private": true,
  "version": "0.0.0",
  "workspaces": ["packages/*"],
  "scripts": {
    "dev:client": "npm run dev -w @fiddle/client",
    "dev:server": "npm run dev -w @fiddle/server",
    "dev": "npm-run-all -p dev:client dev:server",
    "build": "npm run build -w @fiddle/client && npm run build -w @fiddle/server",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "devDependencies": {
    "npm-run-all": "^4.1.5"
  }
}
```

### `tsconfig.base.json`

Single source of truth for TypeScript compiler options; each workspace's `tsconfig.json` extends it. The base preserves the current client's compiler options:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

**`packages/client/tsconfig.json`** extends the base and keeps the Vue-specific bits (jsx, types: `["vite/client"]`, etc.) from the current root `tsconfig.json`. `noEmit: true` is fine because Vite handles emission.

**`packages/server/tsconfig.json`** extends the base and overrides for Node ESM output:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "noEmit": false,
    "declaration": false
  },
  "include": ["src/**/*"]
}
```

**`packages/shared/tsconfig.json`** extends the base for editor-side type-checking only (no build):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

## Verification gates

The scaffold PR must satisfy all of the following before merge:

1. `npm install` from a clean checkout succeeds with no warnings about workspace resolution.
2. `npm run dev` from the repo root boots both client (port 5173) and server (port 8787) concurrently.
3. The client opens at `http://localhost:5173` and the existing synth behaves identically — audio works, sequencer works, project save/load works, every existing test still passes (182/182 baseline).
4. `curl http://localhost:8787/health` returns `{"ok":true}` with HTTP 200.
5. In the browser dev console: `new WebSocket('ws://localhost:8787/ws')` opens and receives `{"type":"hello"}` as the first message.
6. `npm test` runs all workspace tests; the existing 182 client tests plus the new server smoke test all pass.
7. `npm run build` produces both the client `dist/` and the server `dist/`.
8. `npx vue-tsc --noEmit -p packages/client` (or equivalent client typecheck) is clean.
9. `docker compose up --build server` boots the server in a container; `/health` and `/ws` smoke tests pass against the containerized instance.
10. `docker build -f packages/server/Dockerfile --target runtime .` builds a production image that runs and serves `/health`.
11. A Vercel preview deploy of the scaffold branch builds and serves the client correctly; the preview URL is verified manually before merge.

## Out of scope

Explicitly **not** part of this scaffold, to prevent design-by-accident:

- Sync protocol of any kind. `/ws` sends a `hello` and logs incoming messages — that is the entire WS surface.
- Room model, `roomId`, room lifecycle, joining/leaving semantics.
- Client-side WebSocket connection logic. The client does not connect to the server in this PR.
- Shared `Project` reactive subscription, patch emitter, patch applier.
- Authentication, user identity, presence indicators.
- Production deploy of the server to Render (Dockerfile is built and verified locally only; wiring Render env vars, domains, etc. is a follow-up PR).
- CI/CD changes beyond the Vercel preview verification.

All of the above are deliberately deferred to follow-up specs.

## Risks

- **npm workspaces on Vercel.** The `vercel.json`-driven approach should work because the install command runs at the repo root where workspaces are declared. The mitigation is the mandatory preview-deploy gate before merge.
- **Workspace `*` version specifier in deps.** Some tooling treats `"@fiddle/shared": "*"` as "fetch from registry". npm workspaces resolve this to the local workspace correctly, but the Dockerfile's `npm ci --workspace=@fiddle/server --include-workspace-root` must be run from the repo root with the full workspace context present, or it will try to resolve `@fiddle/shared` from npm. The Dockerfile is structured to satisfy this.
- **`tsx` watch + Docker bind mounts on macOS.** File-system event propagation through Docker bind mounts can be flaky. Acceptable risk for dev-only; if it bites, fall back to `npm run dev -w @fiddle/server` outside Docker for local iteration and keep Docker for build/deploy verification.
- **Existing tests run in the new location.** Vitest discovery is config-driven; moving `src/` into `packages/client/src/` plus updating `packages/client/vitest.config.ts` (or `vite.config.ts`'s test block) should keep all 182 tests green. Confirmed via verification gate #6.
- **Vercel previews count against deploy quota.** Negligible at this team size, but worth knowing.

## Branch strategy

- Branch: `feature/backend-scaffolding`, off the latest `main`.
- One branch, one PR. The tasks inside the plan (move client, add server, add shared, add Vercel config, add Docker) are tightly coupled — splitting them produces broken intermediate states that nothing can verify against. The plan will subdivide for ordering, but everything merges to `main` together once all verification gates are green.
- **No merge to `main` without explicit user approval** per the project's standing constraint.
- **No remote push** (other than the one push needed to trigger the Vercel preview deploy) without explicit user approval.

## What lands after this spec

A separate implementation plan (`docs/superpowers/plans/2026-05-26-backend-scaffolding.md`) will decompose this spec into ordered, testable tasks with file paths, code blocks, and verification commands per task — following the project's established TDD + frequent-commit conventions.
