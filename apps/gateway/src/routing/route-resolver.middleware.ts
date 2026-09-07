import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { GatewayRequest } from '../common/gateway-request.js';
import { Problems } from '../common/problem/problem.js';
import { RouteRegistry } from './route-registry.service.js';
import { resolveRoute } from './route-resolver.js';

/** Step 2 of the lifecycle: attach the matching route or answer 404 problem+json. */
@Injectable()
export class RouteResolverMiddleware implements NestMiddleware {
  constructor(private readonly registry: RouteRegistry) {}

  use(req: GatewayRequest, _res: Response, next: NextFunction): void {
    const result = resolveRoute(req.originalUrl, this.registry);
    if (!result.ok) throw Problems.routeNotFound(result.service);
    req.gw = result.value;
    next();
  }
}
