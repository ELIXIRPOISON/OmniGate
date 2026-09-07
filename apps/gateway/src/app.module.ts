import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from './common/logging/logger.module.js';
import { ProblemDetailsFilter } from './common/problem/problem-details.filter.js';
import { RequestIdMiddleware } from './common/request-id.middleware.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { ProxyModule } from './proxy/proxy.module.js';
import { RoutingModule } from './routing/routing.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    RoutingModule,
    ProxyModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
