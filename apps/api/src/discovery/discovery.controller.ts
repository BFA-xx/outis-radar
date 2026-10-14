import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import type { PrismaClient } from '@outis/db';
import {
  type DiscoveryQuery,
  type Paginated,
  discoveryQuerySchema,
  explorerUrl,
  getChain,
  normalizeAddress,
} from '@outis/shared';
import { z } from 'zod';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { type FeedItem, buildFeedOrder, buildFeedWhere, launchpadOf, toFeedItem } from './feed';

const tokenParams = z.object({
  chain: z.string().refine((c) => Boolean(getChain(c)), 'Unknown chain id'),
  address: z.string().min(1).max(200),
});

const historyQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 14).default(24),
});

@Controller()
export class DiscoveryController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** The discovery feed: one row per token (its most liquid pair). */
  @Get('tokens')
  async feed(@Query(new ZodPipe(discoveryQuerySchema)) q: DiscoveryQuery): Promise<Paginated<FeedItem>> {
    const now = new Date();
    const where = buildFeedWhere(q, now);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.pair.count({ where }),
      this.prisma.pair.findMany({
        where,
        orderBy: buildFeedOrder(q),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { baseToken: true },
      }),
    ]);
    return { items: rows.map((r) => toFeedItem(r, now)), page: q.page, pageSize: q.pageSize, total };
  }

  @Get('tokens/:chain/:address')
  async token(
    @Param(new ZodPipe(tokenParams)) p: z.infer<typeof tokenParams>,
    @Query(new ZodPipe(historyQuery)) h: z.infer<typeof historyQuery>,
  ) {
    const chain = getChain(p.chain)!;
    const address = normalizeAddress(chain, p.address);
    const token = await this.prisma.token.findUnique({
      where: { chainId_address: { chainId: chain.id, address } },
      include: { pairs: { include: { baseToken: true }, orderBy: { liquidityUsd: { sort: 'desc', nulls: 'last' } } } },
    });
    if (!token) throw new NotFoundException({ code: 'not_found', message: 'Token is not tracked' });

    const now = new Date();
    const primary = token.pairs.find((x) => x.isPrimary) ?? token.pairs[0];
    const snapshots = primary
      ? await this.prisma.marketSnapshot.findMany({
          where: { pairId: primary.id, observedAt: { gte: new Date(now.getTime() - h.hours * 60 * 60_000) } },
          orderBy: { observedAt: 'asc' },
          take: 2000,
        })
      : [];

    const assessments = await this.prisma.riskAssessment.findMany({
      where: { tokenId: token.id },
      orderBy: { computedAt: 'desc' },
      take: 50,
      select: { score: true, level: true, coverage: true, flaggedChecks: true, momentumScore: true, computedAt: true },
    });

    return {
      chain: { id: chain.id, name: chain.displayName, family: chain.family },
      risk: {
        score: token.riskScore,
        level: token.riskLevel,
        coverage: token.riskCoverage,
        assessedAt: token.riskAssessedAt?.toISOString() ?? null,
        contractCheckedAt: token.contractCheckedAt?.toISOString() ?? null,
        contractNextCheckAt: token.contractNextCheckAt?.toISOString() ?? null,
        detail: token.riskDetail,
        history: assessments.map((a) => ({ ...a, computedAt: a.computedAt.toISOString() })),
      },
      launchpad: launchpadOf(token),
      momentum: { score: token.momentumScore, detail: token.momentum, computedAt: token.momentumAt?.toISOString() ?? null },
      token: {
        id: token.id,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        imageUrl: token.imageUrl,
        firstSeenAt: token.firstSeenAt.toISOString(),
        firstSeenSource: token.firstSeenSource,
        metadataSource: token.metadataSource,
        metadataUpdatedAt: token.metadataUpdatedAt?.toISOString() ?? null,
        explorerUrl: explorerUrl(chain, 'token', token.address) ?? null,
      },
      pairs: token.pairs.map((pair) => ({ ...toFeedItem(pair, now), isPrimary: pair.isPrimary })),
      history: snapshots.map((s) => ({
        observedAt: s.observedAt.toISOString(),
        source: s.source,
        priceUsd: s.priceUsd,
        liquidityUsd: s.liquidityUsd,
        volumeH1: s.volumeH1,
        txnsH1: s.txnsH1,
        buyersH1: s.buyersH1,
      })),
      historyWindowHours: h.hours,
    };
  }
}
