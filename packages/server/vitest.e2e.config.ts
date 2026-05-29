import { defineConfig } from 'vitest/config';

// E2E run: only the *.e2e.test.ts specs, which boot the real server on an
// ephemeral port and drive it over actual WebSocket connections.
export default defineConfig({
  test: {
    include: ['**/*.e2e.test.ts'],
  },
});
