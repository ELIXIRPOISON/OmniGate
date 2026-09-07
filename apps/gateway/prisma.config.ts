import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env itself. Reuse the same lookup as the app: nearest .env walking up
// from the package dir (repo root in this monorepo). Real environment variables always win.
let dir = process.cwd();
for (let i = 0; i < 4; i++) {
  const candidate = join(dir, '.env');
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Seed is a compiled part of the app (dist/prisma/seed.js) so it runs in the container without tsx.
    seed: 'node dist/prisma/seed.js',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
