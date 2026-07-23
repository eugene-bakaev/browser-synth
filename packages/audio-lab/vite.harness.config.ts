import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// root = the harness page; publicDir = client's public/ so /worklets/* resolve
// to the prebuilt worklet bundles. fs.allow the repo root so deep imports into
// @fiddle/client/src/** and @fiddle/shared/src/** are served in dev.
export default defineConfig({
  root: abs('./src/tier2/harness'),
  publicDir: abs('../client/public'),
  server: {
    port: 5190,
    strictPort: false, // auto-bump if busy — never collide with the user's :5173
    fs: { allow: [abs('../..')] },
  },
});
