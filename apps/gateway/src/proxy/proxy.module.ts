import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { RouteResolverMiddleware } from '../routing/route-resolver.middleware.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ProxyController } from './proxy.controller.js';
import { ProxyService } from './proxy.service.js';

@Module({
  imports: [RoutingModule, AuthModule, RateLimitModule],
  controllers: [ProxyController],
  providers: [ProxyService],
})
export class ProxyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RouteResolverMiddleware).forRoutes(ProxyController);
  }
}
