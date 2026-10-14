/**
 * Keep Token.launchpad / launchpadStage / graduatedAt in step with the pools we
 * know. Runs on every token a scan touched (DB-only, cheap).
 */
import type { PrismaClient } from '@outis/db';
import { classifyLaunchpad, getLaunchpad } from '@outis/shared';

const BATCH = 500;

export interface LaunchpadStats {
  classified: number;
  graduated: number;
}

/** Classify the given tokens, or every token when `tokenIds` is omitted (backfill). */
export async function classifyTokens(prisma: PrismaClient, tokenIds?: string[], now = new Date()): Promise<LaunchpadStats> {
  const stats: LaunchpadStats = { classified: 0, graduated: 0 };
  let cursor: string | undefined;
  for (let i = 0; ; i++) {
    const ids = tokenIds?.slice(i * BATCH, (i + 1) * BATCH);
    if (tokenIds && ids!.length === 0) break;
    const tokens = await prisma.token.findMany({
      where: ids ? { id: { in: ids } } : undefined,
      select: {
        id: true, chainId: true, address: true, launchpad: true, launchpadStage: true, launchpadEvidence: true, graduatedAt: true,
        pairs: { select: { dexId: true, pairCreatedAt: true, firstSeenAt: true } },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(ids ? {} : cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (tokens.length === 0) break;
    cursor = tokens[tokens.length - 1].id;

    for (const t of tokens) {
      const info = classifyLaunchpad(t.chainId, t.address, t.pairs.map((p) => p.dexId));
      if (!info) {
        if (t.launchpad !== null) await prisma.token.update({ where: { id: t.id }, data: { launchpad: null, launchpadStage: null, launchpadEvidence: null } });
        continue;
      }
      let graduatedAt = t.graduatedAt;
      if (info.stage === 'graduated' && !graduatedAt) {
        // When the graduation pool was created, if a provider told us; otherwise when we first saw it.
        const spec = getLaunchpad(info.launchpad)!;
        const venue = t.pairs.filter((p) => p.dexId && spec.graduatedDexIds.some((g) => (g.endsWith('*') ? p.dexId!.toLowerCase().startsWith(g.slice(0, -1)) : p.dexId!.toLowerCase() === g)));
        const times = venue.map((p) => (p.pairCreatedAt ?? p.firstSeenAt).getTime());
        graduatedAt = new Date(times.length ? Math.min(...times) : now.getTime());
        stats.graduated++;
      }
      if (t.launchpad === info.launchpad && t.launchpadStage === info.stage && t.launchpadEvidence === info.evidence && t.graduatedAt?.getTime() === graduatedAt?.getTime()) continue;
      await prisma.token.update({
        where: { id: t.id },
        data: { launchpad: info.launchpad, launchpadStage: info.stage, launchpadEvidence: info.evidence, graduatedAt },
      });
      stats.classified++;
    }
    if (tokens.length < BATCH && !tokenIds) break;
  }
  return stats;
}
