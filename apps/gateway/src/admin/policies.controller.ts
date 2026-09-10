import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Problems } from '../common/problem/problem.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import { type Page, pageQuery, patchPolicyBody, policyBody } from './dto.js';
import { validate } from './zod-validation.pipe.js';

interface PolicyView {
  id: string;
  name: string;
  windowSeconds: number;
  maxRequests: number;
  createdAt: Date;
  usedBy: { apiKeys: number; routes: number };
}

@Controller('admin/v1/policies')
@UseGuards(AdminJwtGuard)
export class PoliciesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query(validate(pageQuery)) q: { page: number; pageSize: number },
  ): Promise<Page<PolicyView>> {
    const [rows, total] = await Promise.all([
      this.prisma.rateLimitPolicy.findMany({
        orderBy: { createdAt: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { _count: { select: { apiKeys: true, routes: true } } },
      }),
      this.prisma.rateLimitPolicy.count(),
    ]);
    return {
      items: rows.map(toView),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  @Post()
  async create(
    @Body(validate(policyBody))
    body: {
      name: string;
      windowSeconds: number;
      maxRequests: number;
    },
  ): Promise<PolicyView> {
    const existing = await this.prisma.rateLimitPolicy.findUnique({
      where: { name: body.name },
    });
    if (existing)
      throw Problems.conflict(`A policy named "${body.name}" already exists`);
    const row = await this.prisma.rateLimitPolicy.create({
      data: body,
      include: { _count: { select: { apiKeys: true, routes: true } } },
    });
    return toView(row);
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(validate(patchPolicyBody))
    body: Partial<{ name: string; windowSeconds: number; maxRequests: number }>,
  ): Promise<PolicyView> {
    await this.mustExist(id);
    if (body.name) {
      const clash = await this.prisma.rateLimitPolicy.findUnique({
        where: { name: body.name },
      });
      if (clash && clash.id !== id)
        throw Problems.conflict(`A policy named "${body.name}" already exists`);
    }
    const row = await this.prisma.rateLimitPolicy.update({
      where: { id },
      data: body,
      include: { _count: { select: { apiKeys: true, routes: true } } },
    });
    return toView(row);
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: true }> {
    const row = await this.mustExist(id);
    if (row._count.apiKeys > 0 || row._count.routes > 0) {
      throw Problems.conflict(
        `Policy is referenced by ${row._count.apiKeys} key(s) and ${row._count.routes} route(s)`,
      );
    }
    await this.prisma.rateLimitPolicy.delete({ where: { id } });
    return { deleted: true };
  }

  private async mustExist(id: string) {
    const row = await this.prisma.rateLimitPolicy.findUnique({
      where: { id },
      include: { _count: { select: { apiKeys: true, routes: true } } },
    });
    if (!row) throw Problems.notFound(`No policy with id ${id}`);
    return row;
  }
}

function toView(row: {
  id: string;
  name: string;
  windowSeconds: number;
  maxRequests: number;
  createdAt: Date;
  _count: { apiKeys: number; routes: number };
}): PolicyView {
  return {
    id: row.id,
    name: row.name,
    windowSeconds: row.windowSeconds,
    maxRequests: row.maxRequests,
    createdAt: row.createdAt,
    usedBy: { apiKeys: row._count.apiKeys, routes: row._count.routes },
  };
}
