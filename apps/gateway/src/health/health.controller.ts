import { Controller, Get } from '@nestjs/common';
import type { HealthzResponse } from '@omnigate/shared';

@Controller()
export class HealthController {
  /** Liveness: the process is up. Readiness (/readyz) arrives with Redis and Postgres in Sprint 2. */
  @Get('healthz')
  healthz(): HealthzResponse {
    return { status: 'ok' };
  }
}
