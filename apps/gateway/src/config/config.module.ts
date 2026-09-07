import { Global, Module } from '@nestjs/common';
import { loadEnv, type Env } from './env.js';
import { loadRoutesFile, type RouteConfig } from './routes.js';

/** Injection token for the validated environment (`Env`). */
export const ENV = Symbol('ENV');
/** Injection token for the routes loaded from `ROUTES_FILE` at boot (`RouteConfig[]`). */
export const ROUTES = Symbol('ROUTES');

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): Env => loadEnv() },
    {
      provide: ROUTES,
      inject: [ENV],
      useFactory: (env: Env): RouteConfig[] =>
        loadRoutesFile(env.ROUTES_FILE, {
          defaultTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
        }),
    },
  ],
  exports: [ENV, ROUTES],
})
export class ConfigModule {}
