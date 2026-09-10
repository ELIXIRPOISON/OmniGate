import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ENV, ROUTES } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { RouteConfig } from '../config/routes.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RouteLookup } from './route-resolver.js';

export const ROUTES_CHANGED_CHANNEL = 'routes:changed';
export const REFRESH_INTERVAL_MS = 30_000;

/**
 * In-memory route table (docs/02 section 5). `routes.yaml` provides the bootstrap set so the gateway
 * works before anything is in the database; rows in the `routes` table override a yaml entry with the
 * same service name and are the source of truth once the admin API is in use.
 *
 * Refreshed every 30 s, and immediately on `routes:changed` so an admin write takes effect at once
 * across every replica.
 */
@Injectable()
export class RouteRegistry
  implements RouteLookup, OnModuleInit, OnModuleDestroy
{
  private routes = new Map<string, RouteConfig>();
  private timer?: NodeJS.Timeout;
  private subscriber?: Redis;

  constructor(
    @Inject(ROUTES) private readonly yamlRoutes: RouteConfig[],
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RouteRegistry.name);
    this.replaceAll(yamlRoutes);
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref();

    // A dedicated connection: a subscribed client cannot run ordinary commands.
    this.subscriber = new Redis(this.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    });
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', (channel) => {
      if (channel === ROUTES_CHANGED_CHANNEL) void this.refresh();
    });
    try {
      await this.subscriber.connect();
      await this.subscriber.subscribe(ROUTES_CHANGED_CHANNEL);
    } catch (err) {
      this.logger.warn(
        { err_message: (err as Error).message },
        'route change subscription unavailable',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.subscriber?.disconnect();
  }

  get(service: string): RouteConfig | undefined {
    return this.routes.get(service);
  }

  list(): RouteConfig[] {
    return [...this.routes.values()];
  }

  get size(): number {
    return this.routes.size;
  }

  /** Re-read the database and rebuild the table. Postgres being down leaves the current table in place. */
  async refresh(): Promise<number> {
    let rows;
    try {
      rows = await this.prisma.route.findMany({ include: { policy: true } });
    } catch (err) {
      this.logger.warn(
        { err_message: (err as Error).message },
        'route refresh skipped: database unavailable',
      );
      return this.routes.size;
    }
    const merged = new Map<string, RouteConfig>();
    for (const route of this.yamlRoutes) merged.set(route.service, route);
    for (const row of rows) {
      if (!row.enabled) {
        merged.delete(row.service);
        continue;
      }
      merged.set(row.service, fromDbRoute(row, this.env.UPSTREAM_TIMEOUT_MS));
    }
    const changed = !sameRoutes(this.routes, merged);
    this.routes = merged;
    if (changed) {
      this.logger.info(
        {
          routes: [...merged.values()].map(
            (r) => `${r.service} -> ${r.upstream}`,
          ),
          from_db: rows.length,
        },
        `route registry now has ${merged.size} route(s)`,
      );
    }
    return merged.size;
  }

  replaceAll(routes: RouteConfig[]): void {
    this.routes = new Map(routes.map((r) => [r.service, r]));
    this.logger.info(
      { routes: routes.map((r) => `${r.service} -> ${r.upstream}`) },
      `route registry loaded ${routes.length} route(s)`,
    );
  }
}

interface DbRoute {
  id: string;
  service: string;
  upstream: string;
  stripPrefix: boolean;
  methods: string[];
  authRequired: boolean;
  scopes: string[];
  cacheTtlSeconds: number;
  anomalyMode: 'off' | 'async' | 'sync';
  timeoutMs: number;
  enabled: boolean;
  policy?: { windowSeconds: number; maxRequests: number } | null;
}

/** Database row to the runtime shape the resolver and guards expect. */
export function fromDbRoute(
  row: DbRoute,
  defaultTimeoutMs: number,
): RouteConfig {
  return {
    id: row.id,
    service: row.service,
    upstream: row.upstream,
    strip_prefix: row.stripPrefix,
    methods:
      row.methods.length > 0 ? row.methods.map((m) => m.toUpperCase()) : ['*'],
    auth_required: row.authRequired,
    scopes: row.scopes,
    rate_limit: row.policy
      ? {
          window_seconds: row.policy.windowSeconds,
          max_requests: row.policy.maxRequests,
        }
      : undefined,
    cache_ttl_seconds: row.cacheTtlSeconds,
    anomaly_mode: row.anomalyMode,
    // block_on_heuristic is a yaml-only switch for now; database routes use the default.
    block_on_heuristic: false,
    timeout_ms: row.timeoutMs || defaultTimeoutMs,
    enabled: true,
  };
}

function sameRoutes(
  a: Map<string, RouteConfig>,
  b: Map<string, RouteConfig>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [service, route] of a) {
    const other = b.get(service);
    if (!other || JSON.stringify(route) !== JSON.stringify(other)) return false;
  }
  return true;
}
