import { Module } from '@nestjs/common';
import { RouteRegistry } from './route-registry.service.js';

@Module({
  providers: [RouteRegistry],
  exports: [RouteRegistry],
})
export class RoutingModule {}
