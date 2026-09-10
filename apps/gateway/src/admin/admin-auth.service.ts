import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { jwtVerify, SignJWT } from 'jose';
import { PinoLogger } from 'nestjs-pino';
import { Problems } from '../common/problem/problem.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

export const SESSION_HOURS = 12;
/** Login attempts per IP per minute (T12). */
export const LOGIN_ATTEMPTS_PER_MINUTE = 5;

export interface AdminIdentity {
  id: string;
  email: string;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
}

const attemptsKey = (ip: string, minute: number): string =>
  `admin:login:${ip}:${minute}`;

@Injectable()
export class AdminAuthService {
  private readonly secret: Uint8Array;

  constructor(
    @Inject(ENV) env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AdminAuthService.name);
    this.secret = new TextEncoder().encode(env.ADMIN_JWT_SECRET);
  }

  async login(
    email: string,
    password: string,
    clientIp: string,
  ): Promise<LoginResult> {
    await this.enforceLoginRate(clientIp);
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() },
    });

    // Compare against a dummy hash when the user is unknown so timing does not reveal existence.
    const hash =
      admin?.passwordHash ??
      '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, hash).catch(() => false);
    if (!admin || !ok) {
      this.logger.warn({ email, client_ip: clientIp }, 'admin login failed');
      throw Problems.unauthorized('Invalid email or password');
    }

    const expiresIn = SESSION_HOURS * 3_600;
    const accessToken = await new SignJWT({ email: admin.email, typ: 'admin' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(admin.id)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_HOURS}h`)
      .sign(this.secret);

    this.logger.info(
      { admin_id: admin.id, client_ip: clientIp },
      'admin logged in',
    );
    return { accessToken, expiresIn };
  }

  async verify(token: string): Promise<AdminIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256'],
        requiredClaims: ['sub', 'exp'],
      });
      if (payload.typ !== 'admin' || typeof payload.sub !== 'string') {
        throw new Error('not an admin token');
      }
      return {
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : '',
      };
    } catch {
      throw Problems.unauthorized('Admin session missing, invalid or expired');
    }
  }

  /** Fixed window per IP; Redis being down must not lock operators out, so it fails open. */
  private async enforceLoginRate(clientIp: string): Promise<void> {
    const key = attemptsKey(clientIp, Math.floor(Date.now() / 60_000));
    const attempts = await this.redis.safe(
      'admin login rate',
      async (c) => {
        const results =
          (await c.multi().incr(key).expire(key, 120).exec()) ?? [];
        return Number(results[0]?.[1] ?? 0);
      },
      0,
    );
    if (attempts > LOGIN_ATTEMPTS_PER_MINUTE) {
      this.logger.warn(
        { client_ip: clientIp, attempts },
        'admin login rate limit hit',
      );
      throw Problems.rateLimited(
        'Too many login attempts, try again in a minute',
        60,
      );
    }
  }
}
