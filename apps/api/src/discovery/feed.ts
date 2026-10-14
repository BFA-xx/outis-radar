/**
 * Pure pieces of the discovery feed: query → Prisma filter, row → DTO.
 * Kept free of Nest so they are unit-tested directly.
 */
import type { Prisma } from '@outis/db';
import { type DiscoveryQuery, type Freshness, freshnessOf, getChain, getLaunchpad } from '@outis/shared';

const SORT_COLUMN: Record<Exclude<DiscoveryQuery['sort'], 'momentumScore' | 'riskScore' | 'graduatedAt'>, keyof Prisma.PairOrderByWithRelationInput> = {
  pairCreatedAt: 'pairCreatedAt',
  liquidityUsd: 'liquidityUsd',
  volumeH24: 'volumeH24',
  volumeH1: 'volumeH1',
  txnsH1: 'txnsH1',
  priceChangeH1: 'priceChangeH1',
  marketUpdatedAt: 'marketUpdatedAt',
};

export function buildFeedWhere(q: DiscoveryQuery, now = new Date()): Prisma.PairWhereInput {
  const and: Prisma.PairWhereInput[] = [{ isPrimary: true }];
  if (q.chain) and.push({ chainId: { in: q.chain.split(',') } });
  if (q.minLiquidityUsd !== undefined) and.push({ liquidityUsd: { gte: q.minLiquidityUsd } });
  if (q.minVolumeH24 !== undefined) and.push({ volumeH24: { gte: q.minVolumeH24 } });
  if (q.minTxnsH1 !== undefined) and.push({ txnsH1: { gte: q.minTxnsH1 } });
  if (q.maxAgeHours !== undefined) {
    and.push({ pairCreatedAt: { gte: new Date(now.getTime() - q.maxAgeHours * 60 * 60_000) } });
  }
  if (q.freshWithinMinutes !== undefined) {
    and.push({ marketUpdatedAt: { gte: new Date(now.getTime() - q.freshWithinMinutes * 60_000) } });
  }
  if (q.maxRiskScore !== undefined) and.push({ baseToken: { riskScore: { lte: q.maxRiskScore } } });
  if (q.minMomentumScore !== undefined) and.push({ baseToken: { momentumScore: { gte: q.minMomentumScore } } });
  if (q.launchpad) and.push({ baseToken: { launchpad: q.launchpad === 'any' ? { not: null } : q.launchpad } });
  if (q.stage) and.push({ baseToken: { launchpadStage: q.stage } });
  if (q.q) {
    const term = q.q;
    and.push({
      OR: [
        { baseToken: { symbol: { contains: term, mode: 'insensitive' } } },
        { baseToken: { name: { contains: term, mode: 'insensitive' } } },
        // Addresses: exact match, both as typed and lowercased (EVM is stored lowercase).
        { baseToken: { address: { in: [term, term.toLowerCase()] } } },
        { address: { in: [term, term.toLowerCase()] } },
      ],
    });
  }
  return { AND: and };
}

export function buildFeedOrder(q: DiscoveryQuery): Prisma.PairOrderByWithRelationInput[] {
  // Unknown values sort last in either direction — a missing number is not "the smallest".
  if (q.sort === 'momentumScore' || q.sort === 'riskScore' || q.sort === 'graduatedAt') {
    return [{ baseToken: { [q.sort]: { sort: q.order, nulls: 'last' } } }, { id: 'asc' }];
  }
  return [{ [SORT_COLUMN[q.sort]]: { sort: q.order, nulls: 'last' } }, { id: 'asc' }];
}

export type FeedPairRow = Prisma.PairGetPayload<{ include: { baseToken: true } }>;

export interface FeedItem {
  chain: { id: string; name: string };
  token: { address: string; symbol: string | null; name: string | null; imageUrl: string | null };
  pair: { address: string; dexId: string | null; url: string | null; quoteSymbol: string | null };
  pairCreatedAt: string | null;
  ageMinutes: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volume: { m5: number | null; h1: number | null; h24: number | null };
  priceChange: { m5: number | null; h1: number | null; h24: number | null };
  txnsH1: number | null;
  txnsH24: number | null;
  buyersH24: number | null;
  sellersH24: number | null;
  discoveryReasons: string[];
  estimatedFields: string[];
  fieldSources: Record<string, { source: string; at: string }>;
  marketUpdatedAt: string | null;
  freshness: Freshness;
  /** Null = no evidence of a known launchpad (not proof it wasn't one). */
  launchpad: { id: string; name: string; stage: string | null; evidence: string | null; graduatedAt: string | null } | null;
  /** Null means "not computed", never "zero risk". */
  scores: {
    momentum: number | null;
    risk: number | null;
    /** e.g. "caution" — with ":incomplete" when too few checks ran to trust it. */
    riskLevel: string | null;
    riskCoverage: number | null;
    assessedAt: string | null;
    status: 'scored' | 'not_computed';
  };
}

export function toFeedItem(row: FeedPairRow, now = new Date()): FeedItem {
  const chain = getChain(row.chainId);
  return {
    chain: { id: row.chainId, name: chain?.displayName ?? row.chainId },
    token: {
      address: row.baseToken.address,
      symbol: row.baseToken.symbol,
      name: row.baseToken.name,
      imageUrl: row.baseToken.imageUrl,
    },
    pair: { address: row.address, dexId: row.dexId, url: row.url, quoteSymbol: row.quoteTokenSymbol },
    pairCreatedAt: row.pairCreatedAt?.toISOString() ?? null,
    ageMinutes: row.pairCreatedAt ? Math.max(0, Math.round((now.getTime() - row.pairCreatedAt.getTime()) / 60_000)) : null,
    priceUsd: row.priceUsd,
    liquidityUsd: row.liquidityUsd,
    fdvUsd: row.fdvUsd,
    marketCapUsd: row.marketCapUsd,
    volume: { m5: row.volumeM5, h1: row.volumeH1, h24: row.volumeH24 },
    priceChange: { m5: row.priceChangeM5, h1: row.priceChangeH1, h24: row.priceChangeH24 },
    txnsH1: row.txnsH1,
    txnsH24: row.txnsH24,
    buyersH24: row.buyersH24,
    sellersH24: row.sellersH24,
    discoveryReasons: row.discoveryReasons,
    estimatedFields: row.estimatedFields,
    fieldSources: (row.fieldSources ?? {}) as FeedItem['fieldSources'],
    marketUpdatedAt: row.marketUpdatedAt?.toISOString() ?? null,
    freshness: freshnessOf(row.marketUpdatedAt, now),
    launchpad: launchpadOf(row.baseToken),
    scores: {
      momentum: row.baseToken.momentumScore,
      risk: row.baseToken.riskScore,
      riskLevel: row.baseToken.riskLevel,
      riskCoverage: row.baseToken.riskCoverage,
      assessedAt: row.baseToken.riskAssessedAt?.toISOString() ?? null,
      status: row.baseToken.riskAssessedAt ? 'scored' : 'not_computed',
    },
  };
}

export function launchpadOf(t: { launchpad: string | null; launchpadStage: string | null; launchpadEvidence: string | null; graduatedAt: Date | null }): FeedItem['launchpad'] {
  if (!t.launchpad) return null;
  return {
    id: t.launchpad,
    name: getLaunchpad(t.launchpad)?.name ?? t.launchpad,
    stage: t.launchpadStage,
    evidence: t.launchpadEvidence,
    graduatedAt: t.graduatedAt?.toISOString() ?? null,
  };
}
