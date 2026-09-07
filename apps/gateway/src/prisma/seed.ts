import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import { generateApiKey } from '../auth/api-key.js';
import { loadDotenv } from '../config/dotenv.js';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

export const BCRYPT_COST = 12;

export interface SeedOptions {
  adminEmail: string;
  adminPassword: string;
  /** API_KEY_PEPPER: the demo key hash depends on it. */
  pepper: string;
  /** Upstream for the seeded routes; docs/04 §4 uses http://mock-upstream:3001 inside compose. */
  mockUpstreamUrl?: string;
}

export interface SeedResult {
  adminId: string;
  policyIds: Record<'default' | 'strict' | 'generous', string>;
  routeIds: Record<'mock' | 'orders', string>;
  /** The raw key is available only in this return value / this seed run's stdout. */
  demoKey: { id: string; prefix: string; raw: string };
}

/** Idempotent seed per docs/04 §4. Re-running rotates the demo key and prints the new one. */
export async function seed(
  prisma: PrismaClient,
  opts: SeedOptions,
): Promise<SeedResult> {
  const upstream = opts.mockUpstreamUrl ?? 'http://localhost:3001';

  const passwordHash = await bcrypt.hash(opts.adminPassword, BCRYPT_COST);
  const admin = await prisma.adminUser.upsert({
    where: { email: opts.adminEmail },
    update: { passwordHash },
    create: { email: opts.adminEmail, passwordHash },
  });

  const policyDefs = [
    { name: 'default', windowSeconds: 60, maxRequests: 100 },
    { name: 'strict', windowSeconds: 60, maxRequests: 10 },
    { name: 'generous', windowSeconds: 60, maxRequests: 1000 },
  ] as const;
  const policyIds = {} as SeedResult['policyIds'];
  for (const def of policyDefs) {
    const policy = await prisma.rateLimitPolicy.upsert({
      where: { name: def.name },
      update: {
        windowSeconds: def.windowSeconds,
        maxRequests: def.maxRequests,
      },
      create: def,
    });
    policyIds[def.name] = policy.id;
  }

  const routeDefs = [
    {
      service: 'mock',
      upstream,
      authRequired: false,
      scopes: [] as string[],
      cacheTtlSeconds: 15,
      anomalyMode: 'async' as const,
      policyId: policyIds.default,
    },
    {
      service: 'orders',
      upstream,
      authRequired: true,
      scopes: ['orders:read'],
      cacheTtlSeconds: 30,
      anomalyMode: 'sync' as const,
      policyId: policyIds.default,
    },
  ];
  const routeIds = {} as SeedResult['routeIds'];
  for (const def of routeDefs) {
    const { service, ...rest } = def;
    const route = await prisma.route.upsert({
      where: { service },
      update: rest,
      create: { service, ...rest },
    });
    routeIds[service as 'mock' | 'orders'] = route.id;
  }

  await prisma.apiKey.updateMany({
    where: { name: 'demo', status: 'active' },
    data: { status: 'revoked' },
  });
  const generated = generateApiKey(opts.pepper);
  const key = await prisma.apiKey.create({
    data: {
      name: 'demo',
      prefix: generated.prefix,
      keyHash: generated.keyHash,
      scopes: ['orders:read'],
      policyId: policyIds.default,
    },
  });

  return {
    adminId: admin.id,
    policyIds,
    routeIds,
    demoKey: { id: key.id, prefix: key.prefix, raw: generated.raw },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadDotenv();
  const env = loadEnv();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const result = await seed(prisma, {
      adminEmail: env.ADMIN_EMAIL,
      adminPassword: env.ADMIN_PASSWORD,
      pepper: env.API_KEY_PEPPER,
      mockUpstreamUrl: process.env.MOCK_UPSTREAM_URL,
    });
    console.log(
      `Seeded admin ${env.ADMIN_EMAIL}, ${Object.keys(result.policyIds).length} policies, ${Object.keys(result.routeIds).length} routes.`,
    );
    console.log('');
    console.log('Demo API key (shown once, store it now):');
    console.log(`  ${result.demoKey.raw}`);
    console.log('');
    console.log(
      `Try: curl -i -H "X-API-Key: ${result.demoKey.raw}" http://localhost:8080/api/orders/items`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
