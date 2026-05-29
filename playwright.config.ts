import { defineConfig, devices } from '@playwright/test';

// Browser E2E for the sync feature. Boots the real server (:8787) and Vite
// client (:5173, which proxies /ws to the server) and drives two browser
// contexts as two collaborating clients.
//
// Run: `npm run e2e`. Requires the chromium browser once: `npx playwright install chromium`.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:server',
      url: 'http://localhost:8787/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev:client',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
