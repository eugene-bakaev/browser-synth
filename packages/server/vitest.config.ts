import { defineConfig } from 'vitest/config';

// Default unit/integration run. E2E specs (which boot a real listening socket)
// are excluded here and run separately via `npm run test:e2e`.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e.test.ts'],
  },
});
