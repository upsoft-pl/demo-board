import { defineConfig, devices } from '@playwright/test';
import { ports } from './scripts/ports.js';

const CI = !!process.env.CI;
// Per-worktree ports (see scripts/ports.js): main checkout stays on 5174/5175.
const { e2e: E2E_PORT, preview: PREVIEW_PORT } = ports();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    // fixed viewport: every geometric assertion is in these coordinates
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'dev',
      testIgnore: /build\.spec\.js/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${E2E_PORT}` },
    },
    {
      /*
       * The built artefact behaves differently from the dev server: the CSS
       * minifier rewrites units, assets are hashed and inlined differently.
       * A production-only bug once disabled every animation on the deployed
       * site while the whole dev suite stayed green, so the build gets its own
       * smoke pass.
       */
      name: 'build',
      testMatch: /build\.spec\.js/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
  ],
  webServer: [
    {
      command: `npx vite --port ${E2E_PORT} --strictPort`,
      url: `http://localhost:${E2E_PORT}`,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      command: `npm run build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
      url: `http://localhost:${PREVIEW_PORT}`,
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
