import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { MetricsController } from './metrics.controller.js';
import { MetricsGuard } from './metrics.guard.js';
import { MetricsMiddleware } from './metrics.middleware.js';
import { MetricsService } from './metrics.service.js';

/** Global so any module can count something without importing this one. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsGuard, MetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every request, including the control plane: an operator wants to see admin traffic too.
    consumer.apply(MetricsMiddleware).forRoutes('*path');
  }
}
