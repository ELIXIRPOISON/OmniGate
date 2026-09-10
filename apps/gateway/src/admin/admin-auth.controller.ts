import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService, type LoginResult } from './admin-auth.service.js';
import {
  type AdminRequest,
  AdminJwtGuard,
  PublicAdminRoute,
} from './admin-jwt.guard.js';
import { loginBody } from './dto.js';
import { validate } from './zod-validation.pipe.js';

@Controller('admin/v1/auth')
@UseGuards(AdminJwtGuard)
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @PublicAdminRoute()
  login(
    @Body(validate(loginBody)) body: { email: string; password: string },
    @Req() req: Request,
  ): Promise<LoginResult> {
    return this.auth.login(body.email, body.password, req.ip ?? 'unknown');
  }

  @Get('me')
  me(@Req() req: AdminRequest): { id: string; email: string } {
    return { id: req.admin?.id ?? '', email: req.admin?.email ?? '' };
  }
}
