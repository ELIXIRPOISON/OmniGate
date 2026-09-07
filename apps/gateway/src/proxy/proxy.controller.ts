import { All, Controller, Next, Req, Res, UseGuards } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { GatewayRequest } from '../common/gateway-request.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Problems } from '../common/problem/problem.js';
import { ProxyService } from './proxy.service.js';

/**
 * Data plane entry point: ANY /api/{service}/{path...}.
 * A controller (rather than raw middleware) so guards and interceptors from later sprints
 * slot in front of the proxy the normal Nest way (ADR-001).
 */
@Controller('api')
@UseGuards(AuthGuard)
export class ProxyController {
  constructor(private readonly proxy: ProxyService) {}

  /** Bare /api has no service segment; the resolver middleware already answers 404 before this runs. */
  @All()
  root(): never {
    throw Problems.routeNotFound();
  }

  @All('{*path}')
  forward(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    return this.proxy.forward(req, res, next);
  }
}
