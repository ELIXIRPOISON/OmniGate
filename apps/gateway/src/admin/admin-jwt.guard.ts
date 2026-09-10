import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Problems } from '../common/problem/problem.js';
import { AdminAuthService, type AdminIdentity } from './admin-auth.service.js';

export const PUBLIC_ADMIN_ROUTE = 'public_admin_route';
/** Marks the login endpoint, the only admin route reachable without a session. */
export const PublicAdminRoute = (): MethodDecorator =>
  SetMetadata(PUBLIC_ADMIN_ROUTE, true);

export interface AdminRequest extends Request {
  admin?: AdminIdentity;
}

/** Every /admin/v1 route except login requires `Authorization: Bearer <admin JWT>` (docs/03 section 2). */
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ADMIN_ROUTE,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AdminRequest>();
    const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(
      req.headers.authorization ?? '',
    );
    if (!match) throw Problems.unauthorized('Admin session required');
    req.admin = await this.auth.verify(match[1]);
    return true;
  }
}
