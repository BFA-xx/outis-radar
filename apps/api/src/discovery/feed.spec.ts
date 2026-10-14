import { describe, expect, it } from 'vitest';
import { discoveryQuerySchema } from '@outis/shared';
import { buildFeedOrder, buildFeedWhere, toFeedItem, type FeedPairRow } from './feed';

const now = new Date('2026-10-11T12:00:00Z');

describe('discovery query validation', () => {
  it('applies defaults and coerces strings from the query string', () => {
    const q = discoveryQuerySchema.parse({ minLiquidityUsd: '5000', page: '2' });
    expect(q).toMatchObject({ minLiquidityUsd: 5000, page: 2, pageSize: 50, sort: 'pairCreatedAt', order: 'desc' });
  });

  it('treats empty form fields as absent, not zero', () => {
    const q = discoveryQuerySchema.parse({ minLiquidityUsd: '', maxAgeHours: '' });
    expect(q.minLiquidityUsd).toBeUndefined();
    expect(q.maxAgeHours).toBeUndefined();
  });

  it('rejects unknown chains, bad sorts, oversized pages and negatives', () => {
    for (const bad of [{ chain: 'base,narnia' }, { sort: 'drop table' }, { pageSize: '1000' }, { minVolumeH24: '-1' }, { page: '0' }]) {
      expect(discoveryQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts a comma-separated chain list', () => {
    expect(discoveryQuerySchema.parse({ chain: 'solana,base' }).chain).toBe('solana,base');
  });
});

describe('buildFeedWhere', () => {
  it('always restricts to primary pairs (one row per token)', () => {
    expect(buildFeedWhere(discoveryQuerySchema.parse({}), now)).toEqual({ AND: [{ isPrimary: true }] });
  });

  it('translates every filter', () => {
    const where = buildFeedWhere(
      discoveryQuerySchema.parse({
        chain: 'solana,base',
        minLiquidityUsd: '1000',
        minVolumeH24: '50',
        minTxnsH1: '3',
        maxAgeHours: '24',
        freshWithinMinutes: '30',
      }),
      now,
    );
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { chainId: { in: ['solana', 'base'] } },
        { liquidityUsd: { gte: 1000 } },
        { volumeH24: { gte: 50 } },
        { txnsH1: { gte: 3 } },
        { pairCreatedAt: { gte: new Date('2026-10-10T12:00:00Z') } },
        { marketUpdatedAt: { gte: new Date('2026-10-11T11:30:00Z') } },
      ]),
    );
  });

  it('searches EVM addresses case-insensitively by also trying the lowercase form', () => {
    const where = buildFeedWhere(discoveryQuerySchema.parse({ q: '0xABC' }), now);
    expect(JSON.stringify(where)).toContain('"in":["0xABC","0xabc"]');
  });
});

describe('score filters and sorts', () => {
  it('filters on token-level scores', () => {
    const where = buildFeedWhere(discoveryQuerySchema.parse({ maxRiskScore: '40', minMomentumScore: '50' }), now);
    expect(where.AND).toEqual(expect.arrayContaining([{ baseToken: { riskScore: { lte: 40 } } }, { baseToken: { momentumScore: { gte: 50 } } }]));
  });
  it('sorts by a token-level score with unknowns last', () => {
    expect(buildFeedOrder(discoveryQuerySchema.parse({ sort: 'momentumScore' }))[0]).toEqual({ baseToken: { momentumScore: { sort: 'desc', nulls: 'last' } } });
  });
});

describe('buildFeedOrder', () => {
  it('sorts unknown values last in both directions, with a stable tiebreak', () => {
    expect(buildFeedOrder(discoveryQuerySchema.parse({ sort: 'liquidityUsd', order: 'asc' }))).toEqual([
      { liquidityUsd: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });
});

describe('toFeedItem', () => {
  const row = {
    id: 'p1',
    chainId: 'base',
    address: '0xpair',
    dexId: 'aerodrome',
    baseTokenId: 't1',
    quoteTokenAddress: '0xq',
    quoteTokenSymbol: 'WETH',
    quoteTokenName: null,
    url: null,
    pairCreatedAt: new Date('2026-10-11T11:00:00Z'),
    pairCreatedAtSource: 'geckoterminal',
    isPrimary: true,
    discoveryReasons: ['new_pool'],
    firstSeenAt: now,
    priceUsd: 1,
    priceNative: null,
    liquidityUsd: null,
    fdvUsd: null,
    marketCapUsd: null,
    volumeM5: null,
    volumeH1: null,
    volumeH6: null,
    volumeH24: null,
    priceChangeM5: null,
    priceChangeH1: null,
    priceChangeH6: null,
    priceChangeH24: null,
    txns: null,
    txnsH1: null,
    txnsH24: null,
    buyersH24: null,
    sellersH24: null,
    fieldSources: null,
    estimatedFields: [],
    marketUpdatedAt: new Date('2026-10-11T11:58:00Z'),
    refreshAttemptedAt: null,
    createdAt: now,
    updatedAt: now,
    baseToken: {
      id: 't1',
      chainId: 'base',
      address: '0xtoken',
      symbol: 'TKN',
      name: 'Token',
      decimals: 18,
      imageUrl: null,
      metadataSource: 'geckoterminal',
      metadataUpdatedAt: now,
      firstSeenAt: now,
      firstSeenSource: 'geckoterminal',
      riskScore: null,
      riskLevel: null,
      riskCoverage: null,
      riskAssessedAt: null,
      riskDetail: null,
      momentumScore: null,
      momentum: null,
      momentumAt: null,
      contractCheckedAt: null,
      contractNextCheckAt: null,
      createdAt: now,
      updatedAt: now,
    },
  } satisfies FeedPairRow;

  it('keeps unknown values null and never fabricates scores', () => {
    const item = toFeedItem(row, now);
    expect(item.liquidityUsd).toBeNull();
    expect(item.scores).toEqual({ momentum: null, risk: null, riskLevel: null, riskCoverage: null, assessedAt: null, status: 'not_computed' });
    expect(item.ageMinutes).toBe(60);
    expect(item.freshness).toBe('live');
    expect(item.chain.name).toBe('Base');
  });

  it('passes assessed scores through with their level and coverage', () => {
    const item = toFeedItem({ ...row, baseToken: { ...row.baseToken, riskScore: 42, riskLevel: 'caution:incomplete', riskCoverage: 0.4, riskAssessedAt: now, momentumScore: 55.5 } }, now);
    expect(item.scores).toMatchObject({ risk: 42, riskLevel: 'caution:incomplete', riskCoverage: 0.4, momentum: 55.5, status: 'scored' });
  });

  it('reports unknown age when the pair creation time is unknown', () => {
    expect(toFeedItem({ ...row, pairCreatedAt: null }, now).ageMinutes).toBeNull();
  });
});
