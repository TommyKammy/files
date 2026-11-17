import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The suite now runs 40+ Miniflare workers in parallel. The 5s Vitest default
  // occasionally times out the `/api/health` smoke request while every worker
  // boots its D1/DO bindings; correctness assertions are unaffected.
  test: {
    testTimeout: 20_000,
  },
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations('./migrations');
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
});
