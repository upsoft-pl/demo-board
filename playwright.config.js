import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

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
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5174' },
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
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5175' },
    },
  ],
  webServer: [
    {
      command: 'npx vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      command: 'npm run build && npx vite preview --port 5175 --strictPort',
      url: 'http://localhost:5175',
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
