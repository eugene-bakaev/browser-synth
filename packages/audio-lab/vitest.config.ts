import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/src/audit/audit.test.ts', '**/*.tier2.test.ts'],
  },
});
