import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import { AnomaliesController } from './anomalies.controller.js';
import { ApiKeysController } from './api-keys.controller.js';
import { LogsController } from './logs.controller.js';
import { MetricsController } from './metrics.controller.js';
import { PoliciesController } from './policies.controller.js';
import { RoutesController } from './routes.controller.js';

/** Control plane: /admin/v1 (docs/03 section 2). Everything except login needs an admin session. */
@Module({
  imports: [RoutingModule, CacheModule, AuthModule],
  controllers: [
    AdminAuthController,
    ApiKeysController,
    RoutesController,
    PoliciesController,
    MetricsController,
    AnomaliesController,
    LogsController,
  ],
  providers: [AdminAuthService, AdminJwtGuard],
  exports: [AdminAuthService],
})
export class AdminModule {}
