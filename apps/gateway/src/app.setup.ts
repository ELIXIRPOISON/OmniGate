import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';

/** Runtime settings shared by main.ts and the e2e harness so tests exercise the real configuration. */
export function configureApp(
  app: NestExpressApplication,
  env: Env,
): NestExpressApplication {
  app.useLogger(app.get(Logger));
  // `1` = trust exactly one hop (Fly/ALB); false = never trust X-Forwarded-* (T3).
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.disable('etag');
  app.enableShutdownHooks();
  return app;
}
