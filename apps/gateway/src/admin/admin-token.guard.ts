import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Problems } from '../common/problem/problem.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * Temporary admin authentication until Sprint 7 replaces it with the admin login + JWT:
 * `Authorization: Bearer <ADMIN_TOKEN>`. When ADMIN_TOKEN is unset the admin API is disabled.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = this.env.ADMIN_TOKEN;
    if (!expected)
      throw Problems.serviceUnavailable(
        'Admin API is disabled: ADMIN_TOKEN is not configured',
      );
    const header = req.headers.authorization ?? '';
    const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
    const presented = match?.[1] ?? '';
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw Problems.unauthorized('Admin token missing or invalid');
    }
    return true;
  }
}
