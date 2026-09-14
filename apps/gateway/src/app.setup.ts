import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';

/**
 * Where the built dashboard lands in the production image (docs/10 section 1): the compiled gateway
 * sits at /app/dist/main.js and the dashboard at /app/public/dashboard. In development the directory
 * does not exist and Vite serves the dashboard instead, so serving is skipped.
 */
const DASHBOARD_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'dashboard',
);

/** Paths the gateway owns. The SPA fallback must never answer for these. */
const CONTROL_PLANE = ['/api', '/admin', '/healthz', '/readyz', '/metrics'];

const ownedByGateway = (path: string): boolean =>
  CONTROL_PLANE.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Serves the built dashboard from the gateway so `docker compose up` gives the whole product on one
 * port and a deploy is one container rather than a stack.
 *
 * Ordering is deliberate. Both middlewares run before Nest's controllers, so the fallback decides for
 * itself rather than relying on route registration order: it answers only GET/HEAD requests for
 * paths the gateway does not own, from clients that asked for HTML. An XHR to a bad admin path still
 * gets the JSON 404 it expects, not an HTML page.
 */
function serveDashboard(app: NestExpressApplication): void {
  if (!existsSync(join(DASHBOARD_DIR, 'index.html'))) return;

  app.use(
    express.static(DASHBOARD_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        // Vite emits content-hashed filenames under assets/, so those are immutable. Everything
        // else, index.html above all, must revalidate or a deploy never reaches the browser.
        const hashed = /[\\/]assets[\\/]/.test(filePath);
        res.setHeader(
          'Cache-Control',
          hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );

  app.use((req: express.Request, res: express.Response, next: () => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (ownedByGateway(req.path)) return next();
    // A path whose last segment has an extension is asking for a file. express.static already had
    // its chance, so let it 404 rather than answering an image request with HTML. Everything else is
    // a client-side route. Content negotiation is deliberately not used here: curl and uptime
    // checkers send `Accept: */*`, and answering those with 404 while a browser gets 200 is worse
    // than occasionally returning HTML.
    if (/\.[a-z0-9]+$/i.test(req.path.split('/').pop() ?? '')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(DASHBOARD_DIR, 'index.html'));
  });
}

/** Runtime settings shared by main.ts and the e2e harness so tests exercise the real configuration. */
export function configureApp(
  app: NestExpressApplication,
  env: Env,
): NestExpressApplication {
  app.useLogger(app.get(Logger));
  // Body parsing is off globally so proxied requests stream through untouched (docs/08 R4).
  // The control plane is ordinary JSON, so parse it for /admin only.
  app.use('/admin', express.json({ limit: '1mb' }));
  serveDashboard(app);
  // `1` = trust exactly one hop (Fly/ALB); false = never trust X-Forwarded-* (T3).
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.disable('etag');
  app.enableShutdownHooks();
  return app;
}
