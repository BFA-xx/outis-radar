import { Controller, Get, Inject } from '@nestjs/common';
import type { PrismaClient } from '@outis/db';
import { LAUNCHPADS } from '@outis/shared';
import { PRISMA } from '../common/prisma.module';
import { launchpadOf } from '../discovery/feed';

const DAY_MS = 24 * 60 * 60_000;

@Controller()
export class LaunchpadsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Per-launchpad activity as WE observed it. The scanner samples each chain's
   * newest pools every few minutes, so these are counts of what we saw, not
   * the launchpad's own totals.
   */
  @Get('launchpads')
  async overview() {
    const now = Date.now();
    const dayAgo = new Date(now - DAY_MS);
    const [tracked, seen, graduated, recent] = await Promise.all([
      this.prisma.token.groupBy({ by: ['launchpad'], where: { launchpad: { not: null } }, _count: { _all: true } }),
      this.prisma.token.groupBy({ by: ['launchpad'], where: { launchpad: { not: null }, firstSeenAt: { gte: dayAgo } }, _count: { _all: true } }),
      this.prisma.token.groupBy({ by: ['launchpad'], where: { graduatedAt: { gte: dayAgo } }, _count: { _all: true } }),
      this.prisma.token.findMany({
        where: { graduatedAt: { not: null } },
        orderBy: { graduatedAt: 'desc' },
        take: 40,
        include: { pairs: { where: { isPrimary: true }, take: 1 } },
      }),
    ]);
    const count = (rows: Array<{ launchpad: string | null; _count: { _all: number } }>, id: string) => rows.find((r) => r.launchpad === id)?._count._all ?? 0;
    return {
      windowHours: 24,
      launchpads: LAUNCHPADS.map((l) => ({
        id: l.id,
        name: l.name,
        chains: l.chains,
        hasGraduation: l.graduatedDexIds.length > 0,
        tracked: count(tracked, l.id),
        seen24h: count(seen, l.id),
        graduated24h: count(graduated, l.id),
      })).sort((a, b) => b.seen24h + b.graduated24h - (a.seen24h + a.graduated24h) || b.tracked - a.tracked),
      recentGraduates: recent.map((t) => {
        const p = t.pairs[0];
        return {
          chainId: t.chainId,
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          imageUrl: t.imageUrl,
          launchpad: launchpadOf(t),
          liquidityUsd: p?.liquidityUsd ?? null,
          marketCapUsd: p?.marketCapUsd ?? p?.fdvUsd ?? null,
          priceChangeH1: p?.priceChangeH1 ?? null,
          priceChangeH24: p?.priceChangeH24 ?? null,
          volumeH1: p?.volumeH1 ?? null,
          momentumScore: t.momentumScore,
          riskScore: t.riskScore,
          riskLevel: t.riskLevel,
          riskCoverage: t.riskCoverage,
          marketUpdatedAt: p?.marketUpdatedAt?.toISOString() ?? null,
        };
      }),
    };
  }
}
