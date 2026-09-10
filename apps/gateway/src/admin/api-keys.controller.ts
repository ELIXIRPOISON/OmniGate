import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { generateApiKey } from '../auth/api-key.js';
import { ApiKeyService } from '../auth/api-key.service.js';
import { Problems } from '../common/problem/problem.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import {
  apiKeyQuery,
  createApiKeyBody,
  type Page,
  patchApiKeyBody,
} from './dto.js';
import { validate } from './zod-validation.pipe.js';

interface KeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  policyId: string | null;
  policyName: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Returned once, on creation and rotation only: the raw key is never stored (T6). */
interface CreatedKey extends KeyView {
  rawKey: string;
}

const SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  status: true,
  policyId: true,
  lastUsedAt: true,
  expiresAt: true,
  createdAt: true,
  policy: { select: { name: true } },
} as const;

@Controller('admin/v1/api-keys')
@UseGuards(AdminJwtGuard)
export class ApiKeysController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Get()
  async list(
    @Query(validate(apiKeyQuery))
    q: {
      page: number;
      pageSize: number;
      status?: 'active' | 'revoked';
      q?: string;
    },
  ): Promise<Page<KeyView>> {
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { prefix: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.apiKey.findMany({
        where,
        select: SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.apiKey.count({ where }),
    ]);
    return {
      items: rows.map(toView),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(validate(createApiKeyBody))
    body: {
      name: string;
      scopes: string[];
      policyId?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<CreatedKey> {
    await this.assertPolicy(body.policyId);
    const generated = generateApiKey(this.env.API_KEY_PEPPER);
    const row = await this.prisma.apiKey.create({
      data: {
        name: body.name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        scopes: body.scopes,
        policyId: body.policyId ?? null,
        expiresAt: body.expiresAt ?? null,
      },
      select: SELECT,
    });
    return { ...toView(row), rawKey: generated.raw };
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KeyView & { requests24h: number }> {
    const row = await this.prisma.apiKey.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!row) throw Problems.notFound(`No API key with id ${id}`);
    const [{ count }] = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM audit_logs
      WHERE api_key_id = ${id}::uuid AND ts >= now() - interval '24 hours'`;
    return { ...toView(row), requests24h: Number(count) };
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(validate(patchApiKeyBody))
    body: Partial<{
      name: string;
      scopes: string[];
      policyId: string | null;
      status: 'active' | 'revoked';
      expiresAt: Date | null;
    }>,
  ): Promise<KeyView> {
    const current = await this.prisma.apiKey.findUnique({
      where: { id },
      select: { prefix: true },
    });
    if (!current) throw Problems.notFound(`No API key with id ${id}`);
    if (body.policyId !== undefined) await this.assertPolicy(body.policyId);

    const row = await this.prisma.apiKey.update({
      where: { id },
      data: body,
      select: SELECT,
    });
    // Drop the read-through cache so a revoke or scope change is effective immediately.
    await this.apiKeys.invalidate(current.prefix);
    return toView(row);
  }

  @Post(':id/rotate')
  @HttpCode(200)
  async rotate(@Param('id', ParseUUIDPipe) id: string): Promise<CreatedKey> {
    const current = await this.prisma.apiKey.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) throw Problems.notFound(`No API key with id ${id}`);

    const generated = generateApiKey(this.env.API_KEY_PEPPER);
    const [, created] = await this.prisma.$transaction([
      this.prisma.apiKey.update({ where: { id }, data: { status: 'revoked' } }),
      this.prisma.apiKey.create({
        data: {
          name: current.name,
          prefix: generated.prefix,
          keyHash: generated.keyHash,
          scopes: current.scopes,
          policyId: current.policyId,
          expiresAt: current.expiresAt,
        },
        select: SELECT,
      }),
    ]);
    await this.apiKeys.invalidate(current.prefix);
    return { ...toView(created), rawKey: generated.raw };
  }

  /** Soft delete: keys are revoked, never removed, so audit rows keep referring to something real. */
  @Delete(':id')
  async revoke(@Param('id', ParseUUIDPipe) id: string): Promise<KeyView> {
    const current = await this.prisma.apiKey.findUnique({
      where: { id },
      select: { prefix: true },
    });
    if (!current) throw Problems.notFound(`No API key with id ${id}`);
    const row = await this.prisma.apiKey.update({
      where: { id },
      data: { status: 'revoked' },
      select: SELECT,
    });
    await this.apiKeys.invalidate(current.prefix);
    return toView(row);
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
}

function toView(row: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  policyId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  policy?: { name: string } | null;
}): KeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    status: row.status,
    policyId: row.policyId,
    policyName: row.policy?.name ?? null,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
