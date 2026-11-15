/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as ApiEnv } from '../src/types/api';

interface TestBindings extends ApiEnv {
  TEST_MIGRATIONS: D1Migration[];
}

declare global {
  namespace Cloudflare {
    interface Env extends TestBindings {}
    interface GlobalProps {
      mainModule: typeof import('../src/index');
    }
  }
}

declare module 'cloudflare:test' {
  interface ProvidedEnv extends TestBindings {}
}
