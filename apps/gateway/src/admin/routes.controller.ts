import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { cacheIndexKey } from '../cache/cache-key.js';
import { CacheService } from '../cache/cache.service.js';
import { Problems } from '../common/problem/problem.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  RouteRegistry,
  ROUTES_CHANGED_CHANNEL,
} from '../routing/route-registry.service.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import {
  createRouteBody,
  type Page,
  pageQuery,
  patchRouteBody,
  upstreamIssue,
} from './dto.js';
import { validate } from './zod-validation.pipe.js';

type RouteBody = ReturnType<typeof createRouteBody.parse>;

const SELECT = {
  id: true,
  service: true,
  upstream: true,
  stripPrefix: true,
  methods: true,
  authRequired: true,
  scopes: true,
  policyId: true,
  cacheTtlSeconds: true,
  anomalyMode: true,
  timeoutMs: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  policy: { select: { name: true, windowSeconds: true, maxRequests: true } },
} as const;

@Controller('admin/v1/routes')
@UseGuards(AdminJwtGuard)
export class RoutesController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly registry: RouteRegistry,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async list(
    @Query(validate(pageQuery)) q: { page: number; pageSize: number },
  ): Promise<Page<unknown>> {
    const [rows, total] = await Promise.all([
      this.prisma.route.findMany({
        select: SELECT,
        orderBy: { service: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.route.count(),
    ]);
    return { items: rows, page: q.page, pageSize: q.pageSize, total };
  }

  /** The routes actually in effect right now, database rows merged over the yaml bootstrap set. */
  @Get('effective')
  effective(): { items: unknown[]; total: number } {
    const items = this.registry.list().map((r) => ({
      id: r.id ?? null,
      source: r.id ? 'database' : 'yaml',
      service: r.service,
      upstream: r.upstream,
      authRequired: r.auth_required,
      scopes: r.scopes,
      cacheTtlSeconds: r.cache_ttl_seconds,
      anomalyMode: r.anomaly_mode,
      timeoutMs: r.timeout_ms,
    }));
    return { items, total: items.length };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(validate(createRouteBody)) body: RouteBody,
  ): Promise<unknown> {
    this.assertUpstream(body.upstream);
    await this.assertPolicy(body.policyId);
    const clash = await this.prisma.route.findUnique({
      where: { service: body.service },
    });
    if (clash)
      throw Problems.conflict(
        `A route for service "${body.service}" already exists`,
      );

    const row = await this.prisma.route.create({
      data: { ...body, policyId: body.policyId ?? null },
      select: SELECT,
    });
    await this.publishChange();
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(validate(patchRouteBody)) body: Partial<RouteBody>,
  ): Promise<unknown> {
    await this.mustExist(id);
    if (body.upstream) this.assertUpstream(body.upstream);
    if (body.policyId !== undefined) await this.assertPolicy(body.policyId);
    if (body.service) {
      const clash = await this.prisma.route.findUnique({
        where: { service: body.service },
      });
      if (clash && clash.id !== id)
        throw Problems.conflict(
          `A route for service "${body.service}" already exists`,
        );
    }
    const row = await this.prisma.route.update({
      where: { id },
      data: body,
      select: SELECT,
    });
    await this.publishChange();
    return row;
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: true; purgedKeys: number }> {
    const row = await this.mustExist(id);
    await this.prisma.route.delete({ where: { id } });
    const purgedKeys = await this.cache.purgeRoute(cacheIndexKey(row.service));
    await this.publishChange();
    return { deleted: true, purgedKeys };
  }

  @Post(':id/cache/purge')
  @HttpCode(200)
  async purge(
    @Param('id') id: string,
  ): Promise<{ routeId: string; deletedKeys: number }> {
    // Accept either the database id or the service name, since yaml routes have no row.
    const service = (
      await this.prisma.route
        .findUnique({ where: { id }, select: { service: true } })
        .catch(() => null)
    )?.service;
    const target = service ?? (this.registry.get(id) ? id : undefined);
    if (!target) throw Problems.routeNotFound(id);
    const deletedKeys = await this.cache.purgeRoute(cacheIndexKey(target));
    return { routeId: target, deletedKeys };
  }

  @Post('reload')
  @HttpCode(200)
  async reload(): Promise<{ routes: number }> {
    const routes = await this.registry.refresh();
    await this.publishChange();
    return { routes };
  }

  private assertUpstream(upstream: string): void {
    const issue = upstreamIssue(upstream, this.env.ALLOW_PRIVATE_UPSTREAMS);
    if (issue)
      throw Problems.badRequest(
        `${issue} (set ALLOW_PRIVATE_UPSTREAMS=true for local development)`,
      );
  }

  private async assertPolicy(
    policyId: string | null | undefined,
  ): Promise<void> {
    if (!policyId) return;
    const policy = await this.prisma.rateLimitPolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy)
      throw Problems.badRequest(`No rate-limit policy with id ${policyId}`);
  }

  private async mustExist(id: string) {
    const row = await this.prisma.route.findUnique({
      where: { id },
      select: { id: true, service: true },
    });
    if (!row) throw Problems.notFound(`No route with id ${id}`);
    return row;
  }

  /** Refresh this replica now and tell the others (docs/02 section 5). */
  private async publishChange(): Promise<void> {
    await this.registry.refresh();
    await this.redis.safe(
      'routes changed',
      (c) => c.publish(ROUTES_CHANGED_CHANNEL, '1'),
      0,
    );
  }
}
