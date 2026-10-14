import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

/**
 * One client per process. Next.js dev reloads modules on every change, which
 * would otherwise open a new connection pool each time and exhaust the
 * database's connection limit (Supabase free tier allows few).
 */
const globalForPrisma = globalThis as unknown as { __outisPrisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__outisPrisma) {
    globalForPrisma.__outisPrisma = new PrismaClient({
      log: process.env.PRISMA_LOG_QUERIES === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
  return globalForPrisma.__outisPrisma;
}
