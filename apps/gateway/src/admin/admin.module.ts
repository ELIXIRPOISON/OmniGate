import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { AdminTokenGuard } from './admin-token.guard.js';
import { RoutesCacheController } from './routes-cache.controller.js';

@Module({
  imports: [RoutingModule, CacheModule],
  controllers: [RoutesCacheController],
  providers: [AdminTokenGuard],
})
export class AdminModule {}
