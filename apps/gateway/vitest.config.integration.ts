import { defineConfig } from 'vitest/config';

/** Integration suite: real Redis + Postgres via Testcontainers (docs/09 §2). Needs Docker. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.integration-spec.ts'],
    globalSetup: ['./test/setup/containers.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
