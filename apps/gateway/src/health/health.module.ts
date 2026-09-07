import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [RoutingModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
