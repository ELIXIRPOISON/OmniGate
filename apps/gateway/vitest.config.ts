import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves path aliases declared in tsconfig.json (e.g. from `nest g library`).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.spec.ts', 'src/main.ts', 'src/cli/**', 'src/prisma/seed.ts', 'src/eval/**'],
    },
  },
});
