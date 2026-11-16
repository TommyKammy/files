import { defineConfig, devices } from '@playwright/test';

const apiPort = Number(process.env.E2E_API_PORT ?? 18787);
const webPort = Number(process.env.E2E_WEB_PORT ?? 13000);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? `http://localhost:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * E2E runs are intentionally fully isolated from the interactive dev stack:
 * - API: 127.0.0.1:18787 + .playwright/wrangler-state (never :8787 / apps/api/.wrangler)
 * - Web: localhost:13000 + .next-e2e (never :3000 / apps/web/.next)
 * - Both servers are started by Playwright and stopped with a SIGTERM grace period.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: webOrigin,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
    },
  ],
  webServer: [
    {
      name: 'e2e-api',
      command: 'node e2e/scripts/start-api.mjs',
      url: `${apiOrigin}/api/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      env: childEnv({
        E2E_API_PORT: String(apiPort),
        E2E_WEB_PORT: String(webPort),
        E2E_WEB_ORIGIN: webOrigin,
      }),
    },
    {
      name: 'e2e-web',
      command: `pnpm --filter @files/web exec next dev --port ${webPort}`,
      url: webOrigin,
      timeout: 180_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      env: childEnv({
        NEXT_DIST_DIR: '.next-e2e',
        LOCAL_API_ORIGIN: apiOrigin,
        NEXT_TELEMETRY_DISABLED: '1',
        COLLABORA_URL: process.env.E2E_COLLABORA_URL ?? 'http://localhost:9980',
      }),
    },
  ],
});
