import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against workspace sources, not stale dist/ builds.
    alias: {
      '@outis/shared': resolve(import.meta.dirname, 'packages/shared/src/index.ts'),
      '@outis/engine': resolve(import.meta.dirname, 'packages/engine/src/index.ts'),
      '@outis/db': resolve(import.meta.dirname, 'packages/db/src/index.ts'),
      '@outis/bot': resolve(import.meta.dirname, 'apps/bot/src/bot.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.spec.ts', 'apps/worker/src/**/*.spec.ts', 'apps/api/src/**/*.spec.ts', 'apps/bot/src/**/*.spec.ts', 'apps/web/src/lib/**/*.spec.ts'],
    environment: 'node',
    // Persistence tests share one test database; run files serially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
