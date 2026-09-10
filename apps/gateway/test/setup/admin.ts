import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export const TEST_ADMIN_EMAIL = 'admin@example.com';
export const TEST_ADMIN_PASSWORD = 'admin-test-password';

/**
 * Creates (or updates) the admin user and logs in, returning a bearer token.
 * Admin endpoints are session-protected since Sprint 7, so suites that touch them need this.
 */
export async function adminSession(app: INestApplication): Promise<string> {
  const prisma = app.get(PrismaService);
  const passwordHash = await bcrypt.hash(TEST_ADMIN_PASSWORD, 4);
  await prisma.adminUser.upsert({
    where: { email: TEST_ADMIN_EMAIL },
    update: { passwordHash },
    create: { email: TEST_ADMIN_EMAIL, passwordHash },
  });
  const res = await request(app.getHttpServer())
    .post('/admin/v1/auth/login')
    .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD })
    .expect(200);
  return res.body.accessToken as string;
}
