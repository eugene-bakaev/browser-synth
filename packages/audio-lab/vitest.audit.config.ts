import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/audit/audit.test.ts'],
    testTimeout: 120_000,
    // renders are CPU-bound; default pool parallelism is fine, but keep
    // one file = one worker (it's a single file anyway).
  },
});
