/**
 * Job leases: at most one holder per job name, with expiry so a crashed run
 * (a GitHub Actions runner killed mid-scan) cannot block the next one forever.
 *
 * Acquisition is a single atomic statement — insert, or take over only when
 * the current lease has expired or is already ours.
 */
import type { PrismaClient } from '@outis/db';

export async function acquireLease(
  prisma: PrismaClient,
  name: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ holder: string }>>`
    INSERT INTO "JobLease" ("name", "holder", "acquiredAt", "expiresAt")
    VALUES (${name}, ${holder}, now(), now() + make_interval(secs => ${ttlMs / 1000}::double precision))
    ON CONFLICT ("name") DO UPDATE
       SET "holder" = EXCLUDED."holder",
           "acquiredAt" = EXCLUDED."acquiredAt",
           "expiresAt" = EXCLUDED."expiresAt"
     WHERE "JobLease"."expiresAt" < now() OR "JobLease"."holder" = EXCLUDED."holder"
    RETURNING "holder"`;
  return rows.length === 1 && rows[0].holder === holder;
}

/** Extend a lease we hold. Returns false if it was lost (expired and taken). */
export async function renewLease(prisma: PrismaClient, name: string, holder: string, ttlMs: number): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "JobLease"
       SET "expiresAt" = now() + make_interval(secs => ${ttlMs / 1000}::double precision)
     WHERE "name" = ${name} AND "holder" = ${holder}`;
  return count === 1;
}

export async function releaseLease(prisma: PrismaClient, name: string, holder: string): Promise<void> {
  await prisma.jobLease.deleteMany({ where: { name, holder } });
}
