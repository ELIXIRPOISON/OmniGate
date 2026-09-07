import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ROUTES } from '../config/config.module.js';
import type { RouteConfig } from '../config/routes.js';
import type { RouteLookup } from './route-resolver.js';

/** In-memory route table. Boot-time source is routes.yaml; Phase 4 adds DB rows and live reloads. */
@Injectable()
export class RouteRegistry implements RouteLookup {
  private routes = new Map<string, RouteConfig>();

  constructor(
    @Inject(ROUTES) routes: RouteConfig[],
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RouteRegistry.name);
    this.replaceAll(routes);
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

  replaceAll(routes: RouteConfig[]): void {
    this.routes = new Map(routes.map((r) => [r.service, r]));
    this.logger.info(
      { routes: routes.map((r) => `${r.service} -> ${r.upstream}`) },
      `route registry loaded ${routes.length} route(s)`,
    );
  }
}
