import { defineConfig } from 'vitest/config';

// Browser-launching, on-demand tests only. Never part of `npm test`.
export default defineConfig({
  test: {
    include: ['src/tier2/**/*.tier2.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false, // one browser at a time
  },
});
