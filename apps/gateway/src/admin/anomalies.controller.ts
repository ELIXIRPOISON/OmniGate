import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Problems } from '../common/problem/problem.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { throttleKey } from '../rate-limit/policy.js';
import { RedisService } from '../redis/redis.service.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import { anomalyQuery, type Page, reviewBody, throttleBody } from './dto.js';
import { validate } from './zod-validation.pipe.js';

const LIST_SELECT = {
  id: true,
  requestId: true,
  createdAt: true,
  method: true,
  path: true,
  heuristicScore: true,
  llmScore: true,
  verdict: true,
  categories: true,
  blocked: true,
  reviewed: true,
  reviewLabel: true,
  clientIp: true,
  apiKeyId: true,
  routeId: true,
  apiKey: { select: { name: true, prefix: true } },
  route: { select: { service: true } },
} as const;

@Controller('admin/v1/anomalies')
@UseGuards(AdminJwtGuard)
export class AnomaliesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async list(
    @Query(validate(anomalyQuery))
    q: {
      page: number;
      pageSize: number;
      minScore?: number;
      verdict?: 'benign' | 'suspicious' | 'malicious';
      apiKeyId?: string;
      routeId?: string;
      requestId?: string;
      reviewed?: boolean;
      blocked?: boolean;
      from?: Date;
      to?: Date;
    },
  ): Promise<Page<unknown>> {
    const where = {
      ...(q.verdict ? { verdict: q.verdict } : {}),
      ...(q.apiKeyId ? { apiKeyId: q.apiKeyId } : {}),
      ...(q.routeId ? { routeId: q.routeId } : {}),
      ...(q.requestId ? { requestId: q.requestId } : {}),
      ...(q.reviewed !== undefined ? { reviewed: q.reviewed } : {}),
      ...(q.blocked !== undefined ? { blocked: q.blocked } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: q.from } : {}),
              ...(q.to ? { lt: q.to } : {}),
            },
          }
        : {}),
      // The score an operator cares about is the model's when it exists, the heuristic otherwise.
      ...(q.minScore !== undefined
        ? {
            OR: [
              { llmScore: { gte: q.minScore } },
              { llmScore: null, heuristicScore: { gte: q.minScore } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.anomalyEvent.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.anomalyEvent.count({ where }),
    ]);
    return { items, page: q.page, pageSize: q.pageSize, total };
  }

  @Get(':id')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    const row = await this.prisma.anomalyEvent.findUnique({
      where: { id },
      include: {
        apiKey: { select: { name: true, prefix: true } },
        route: { select: { service: true } },
      },
    });
    if (!row) throw Problems.notFound(`No anomaly event with id ${id}`);
    return row;
  }

  /** Review labels feed the evaluation set (docs/06 section 8.4). */
  @Patch(':id/review')
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(validate(reviewBody))
    body: { reviewed: boolean; label: 'true_positive' | 'false_positive' },
  ): Promise<unknown> {
    const exists = await this.prisma.anomalyEvent.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw Problems.notFound(`No anomaly event with id ${id}`);
    return this.prisma.anomalyEvent.update({
      where: { id },
      data: { reviewed: body.reviewed, reviewLabel: body.label },
      select: LIST_SELECT,
    });
  }

  /** Manual version of the reactive throttle: the rate-limit guard honours the same flag. */
  @Post(':id/throttle-key')
  @HttpCode(200)
  async throttle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(validate(throttleBody)) body: { seconds: number },
  ): Promise<{ principal: string; seconds: number }> {
    const row = await this.prisma.anomalyEvent.findUnique({
      where: { id },
      select: { apiKeyId: true, clientIp: true },
    });
    if (!row) throw Problems.notFound(`No anomaly event with id ${id}`);

    const principal = row.apiKeyId
      ? `api_key:${row.apiKeyId}`
      : row.clientIp
        ? `anon:${row.clientIp}`
        : null;
    if (!principal)
      throw Problems.badRequest('This event has no throttleable principal');

    const ok = await this.redis.safe(
      'admin throttle',
      (c) => c.set(throttleKey(principal), '1', 'EX', body.seconds),
      null,
    );
    if (ok === null)
      throw Problems.serviceUnavailable(
        'Redis unavailable, throttle not applied',
      );
    return { principal, seconds: body.seconds };
  }
}
