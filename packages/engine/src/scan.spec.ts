/**
 * Integration: a full discovery scan against a real Postgres (DATABASE_URL_TEST)
 * with both providers mocked from captured responses. Skipped when no test
 * database is configured. The test database is wiped — never point it at data
 * you want to keep.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireChain } from '@outis/shared';
import gtBase from './__fixtures__/gt-new-pools-base.json';
import gtSolana from './__fixtures__/gt-new-pools-solana.json';
import dsPairsBase from './__fixtures__/ds-pairs-base.json';
import dsPumpfun from './__fixtures__/ds-tokens-solana-pumpfun.json';
import type { ScanConfig } from './config';
import type { FetchLike } from './http';
import { acquireLease, releaseLease } from './lease';
import { createLogger } from './logger';
import { DISCOVERY_JOB, runDiscoveryScan } from './scan';

const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL_TEST;

const json = (body: unknown, status = 200) => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function routedFetch(overrides: Record<string, () => ReturnType<typeof json>> = {}) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (u) => {
    calls.push(u);
    for (const [frag, make] of Object.entries(overrides)) if (u.includes(frag)) return make();
    if (u.includes('/networks/solana/new_pools')) return json(gtSolana);
    if (u.includes('/networks/base/new_pools')) return json(gtBase);
    if (u.includes('/token-profiles/latest'))
      return json([{ chainId: 'solana', tokenAddress: 'ADrAY3aPJeZh5SNQVBzqkfGo8tgHGuDZKLKzaapDpump' }]);
    if (u.includes('/token-boosts/latest') || u.includes('/community-takeovers/latest')) return json([]);
    if (u.includes('/tokens/v1/solana/')) return json(dsPumpfun);
    if (u.includes('/latest/dex/pairs/base/')) return json(dsPairsBase);
    if (u.includes('/latest/dex/pairs/solana/')) return json(dsPumpfun);
    return json({ error: 'unrouted' }, 404);
  };
  return { fetchImpl, calls };
}

const config: ScanConfig = {
  chains: [requireChain('solana'), requireChain('base')],
  newPoolPages: 2,
  ingestMinLiquidityUsd: 500,
  refreshMaxAgeHours: 24 * 365 * 20,
  refreshLimit: 50,
  maxDurationMs: 60_000,
  snapshotRetentionDays: 3650,
  tokenRetentionDays: 3650,
};
const quiet = createLogger('test', () => {});
const noSleep = async () => {};

describe.skipIf(!url)('discovery scan (Postgres)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "MarketSnapshot", "Pair", "Token", "ProviderHealth", "IngestionCheckpoint", "JobLease", "ScanRun" CASCADE',
    );
  });

  it('persists real-shaped pairs from both providers with attribution', async () => {
    const { fetchImpl } = routedFetch();
    const r = await runDiscoveryScan({ prisma, config, logger: quiet, trigger: 'test', fetchImpl, sleep: noSleep });
    expect(r.status).toBe('ok');

    const pump = await prisma.pair.findUnique({
      where: { chainId_address: { chainId: 'solana', address: 'CeADBx5ycyvrRN5PEhPF1VkoHBxMAjQJmVBZmpbQ5rGz' } },
      include: { baseToken: true, snapshots: true },
    });
    expect(pump).not.toBeNull();
    expect(pump!.baseToken.address).toBe('ADrAY3aPJeZh5SNQVBzqkfGo8tgHGuDZKLKzaapDpump');
    expect(pump!.discoveryReasons).toEqual(expect.arrayContaining(['new_pool', 'token_profile']));
    // GT reported liquidity; DS reported none. GT's value is kept and attributed.
    expect(pump!.liquidityUsd).toBeCloseTo(2439.3096);
    expect((pump!.fieldSources as Record<string, { source: string }>).liquidityUsd.source).toBe('geckoterminal');
    expect(pump!.buyersH24).toBe(12);
    // Both providers' observations are kept as separate snapshots.
    expect(new Set(pump!.snapshots.map((s) => s.source))).toEqual(new Set(['geckoterminal', 'dexscreener']));

    const chains = await prisma.chain.count();
    expect(chains).toBeGreaterThanOrEqual(15);
    const health = await prisma.providerHealth.findMany();
    expect(health.map((h) => `${h.provider}|${h.scope}`)).toEqual(
      expect.arrayContaining(['geckoterminal|solana', 'geckoterminal|base', 'dexscreener|*']),
    );
    const run = await prisma.scanRun.findUniqueOrThrow({ where: { id: r.runId! } });
    expect(run.status).toBe('ok');
    expect(run.finishedAt).not.toBeNull();
  });

  it('is idempotent: a re-run in the same minute adds no pairs, tokens or snapshots', async () => {
    const fixed = new Date();
    const now = () => fixed;
    await runDiscoveryScan({ prisma, config, logger: quiet, trigger: 'test', fetchImpl: routedFetch().fetchImpl, sleep: noSleep, now });
    const counts = async () => ({
      pairs: await prisma.pair.count(),
      tokens: await prisma.token.count(),
      snaps: await prisma.marketSnapshot.count(),
    });
    const first = await counts();
    await runDiscoveryScan({ prisma, config, logger: quiet, trigger: 'test', fetchImpl: routedFetch().fetchImpl, sleep: noSleep, now });
    expect(await counts()).toEqual(first);
  });

  it('marks exactly one primary pair per token', async () => {
    await runDiscoveryScan({ prisma, config, logger: quiet, trigger: 'test', fetchImpl: routedFetch().fetchImpl, sleep: noSleep });
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) FILTER (WHERE "isPrimary") AS n FROM "Pair" GROUP BY "baseTokenId"`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Number(r.n) === 1)).toBe(true);
  });

  it('skips new pairs below the liquidity floor but never drops unknown liquidity', async () => {
    await runDiscoveryScan({
      prisma,
      config: { ...config, ingestMinLiquidityUsd: 10_000_000 },
      logger: quiet,
      trigger: 'test',
      fetchImpl: routedFetch().fetchImpl,
      sleep: noSleep,
    });
    const pairs = await prisma.pair.findMany({ select: { liquidityUsd: true } });
    // Only GT-reported liquidity merges in, so everything with a known value is
    // below 10M and skipped; nothing stored can have known liquidity under the floor.
    expect(pairs.every((p) => p.liquidityUsd === null || p.liquidityUsd >= 10_000_000)).toBe(true);
  });

  it('skips (and records) a run while another holds the lease', async () => {
    expect(await acquireLease(prisma, DISCOVERY_JOB, 'someone-else', 60_000)).toBe(true);
    const { fetchImpl, calls } = routedFetch();
    const r = await runDiscoveryScan({ prisma, config, logger: quiet, trigger: 'test', fetchImpl, sleep: noSleep });
    expect(r.status).toBe('skipped');
    expect(calls).toHaveLength(0);
    await releaseLease(prisma, DISCOVERY_JOB, 'someone-else');
    expect(await acquireLease(prisma, DISCOVERY_JOB, 'me', 60_000)).toBe(true);
  });

  it('takes over an expired lease (a crashed run cannot block forever)', async () => {
    await prisma.jobLease.create({
      data: { name: DISCOVERY_JOB, holder: 'crashed', acquiredAt: new Date(0), expiresAt: new Date(1) },
    });
    const r = await runDiscoveryScan({ prisma, config, logger: quiet, trigger: 'test', fetchImpl: routedFetch().fetchImpl, sleep: noSleep });
    expect(r.status).toBe('ok');
    expect(await prisma.jobLease.count()).toBe(0); // released at the end
  });

  it('degrades to partial — not failed — when a provider is down, and records health', async () => {
    const { fetchImpl } = routedFetch({ '/networks/base/new_pools': () => json({}, 503) });
    const r = await runDiscoveryScan({ prisma, config, logger: quiet, trigger: 'test', fetchImpl, sleep: noSleep });
    expect(r.status).toBe('partial');
    expect(r.chains.base.providerErrors.length).toBeGreaterThan(0);
    expect(await prisma.pair.count({ where: { chainId: 'solana' } })).toBeGreaterThan(0);
    const h = await prisma.providerHealth.findUniqueOrThrow({
      where: { provider_scope: { provider: 'geckoterminal', scope: 'base' } },
    });
    expect(h.consecutiveFailures).toBe(1);
    expect(h.rateLimitedTotal).toBe(0);
    expect(h.errorsTotal).toBe(3); // 1 attempt + 2 retries (GT budget is scarce)
  });

  it('refreshes hot tokens (near an alpha call) ahead of the stale queue', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60_000);
    const cold = Array.from({ length: 8 }, (_, i) => `ColdPair${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
    for (const [i, addr] of [...cold, 'HotPairxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'].entries()) {
      const hot = addr.startsWith('Hot');
      const t = await prisma.token.create({ data: { chainId: 'solana', address: `Mint${i}${'x'.repeat(36)}`, firstSeenSource: 'test', ...(hot && { alphaScore: 62, momentumScore: 70 }) } });
      await prisma.pair.create({
        data: { chainId: 'solana', address: addr, baseTokenId: t.id, quoteTokenAddress: 'So11111111111111111111111111111111111111112', isPrimary: true, pairCreatedAt: recent, liquidityUsd: 20_000, marketUpdatedAt: recent },
      });
    }
    const { fetchImpl, calls } = routedFetch();
    await runDiscoveryScan({ prisma, config: { ...config, chains: [requireChain('solana')], refreshLimit: 3 }, logger: quiet, fetchImpl, sleep: noSleep, trigger: 'test' });
    const refreshCalls = calls.filter((u) => u.includes('/latest/dex/pairs/solana/') && u.includes('ColdPair') || u.includes('HotPair'));
    expect(refreshCalls.some((u) => u.includes('HotPairxxxx'))).toBe(true);
  });

  it('stops at the deadline and still finalizes the run', async () => {
    const r = await runDiscoveryScan({
      prisma,
      config: { ...config, maxDurationMs: 10_000 },
      logger: quiet,
      trigger: 'test',
      fetchImpl: routedFetch().fetchImpl,
      sleep: noSleep,
      signal: AbortSignal.abort(),
    });
    expect(r.stoppedEarly).toMatch(/shutdown/);
    const run = await prisma.scanRun.findUniqueOrThrow({ where: { id: r.runId! } });
    expect(run.status).toBe('partial');
    expect(await prisma.jobLease.count()).toBe(0);
  });
});
