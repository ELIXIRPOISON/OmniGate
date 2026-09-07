import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Load the nearest .env walking up from cwd (package dir in dev, repo root in compose). Never overrides real env. */
export function loadDotenv(
  startDir: string = process.cwd(),
  maxLevels = 4,
): string | undefined {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
