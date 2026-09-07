import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadDotenv } from './config/dotenv.js';
import { type Env, EnvValidationError, loadEnv } from './config/env.js';
import { RoutesValidationError } from './config/routes.js';

function fatal(err: unknown): never {
  if (
    err instanceof EnvValidationError ||
    err instanceof RoutesValidationError
  ) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

loadDotenv();

// Validate before Nest boots so a misconfigured deploy fails with one readable message (S1-02).
function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    return fatal(err);
  }
}

const env = loadEnvOrExit();

async function bootstrap(): Promise<void> {
  // bodyParser: false -> request bodies stream straight through the proxy (risk R4 in docs/08).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app, env);
  await app.listen(env.PORT);
}

try {
  await bootstrap();
} catch (err) {
  fatal(err);
}
