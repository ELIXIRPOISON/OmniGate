import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MetricsGuard } from './metrics.guard.js';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
@UseGuards(MetricsGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  scrape(@Req() _req: Request): string {
    return this.metrics.render();
  }
}
