import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { cacheIndexKey } from '../cache/cache-key.js';
import { CacheService } from '../cache/cache.service.js';
import { Problems } from '../common/problem/problem.js';
import { RouteRegistry } from '../routing/route-registry.service.js';
import { AdminTokenGuard } from './admin-token.guard.js';

/** POST /admin/v1/routes/:id/cache/purge -> { deletedKeys } (docs/03 §2, docs/05 §2.5). `:id` is the service name until DB routes arrive. */
@Controller('admin/v1/routes')
@UseGuards(AdminTokenGuard)
export class RoutesCacheController {
  constructor(
    private readonly registry: RouteRegistry,
    private readonly cache: CacheService,
  ) {}

  @Post(':id/cache/purge')
  @HttpCode(200)
  async purge(
    @Param('id') id: string,
  ): Promise<{ routeId: string; deletedKeys: number }> {
    const route = this.registry.get(id);
    if (!route) throw Problems.routeNotFound(id);
    const deletedKeys = await this.cache.purgeRoute(
      cacheIndexKey(route.service),
    );
    return { routeId: route.service, deletedKeys };
  }
}
