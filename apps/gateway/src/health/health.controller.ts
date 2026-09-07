import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthzResponse, ReadyzResponse } from '@omnigate/shared';
import { HealthService } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is up. */
  @Get('healthz')
  healthz(): HealthzResponse {
    return { status: 'ok' };
  }

  /** Readiness: 200 only when Redis and Postgres both answer; 503 with the breakdown otherwise. */
  @Get('readyz')
  async readyz(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadyzResponse> {
    const result = await this.health.readiness();
    if (result.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
