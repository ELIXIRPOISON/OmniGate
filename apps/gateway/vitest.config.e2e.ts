import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves path aliases declared in tsconfig.json (e.g. from `nest g library`).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
