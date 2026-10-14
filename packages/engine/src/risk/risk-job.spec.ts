/** Risk job + assessment against a real Postgres (DATABASE_URL_TEST); GoPlus mocked. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import paper from '../__fixtures__/goplus-base-paper.json';
import type { FetchLike } from '../http';
import { createLogger } from '../logger';
import { syncChains } from '../persist';
import { assessTokens, runRiskJob } from './assess';

const envFile = resolve(__dirname, '../../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL_TEST;
const quiet = createLogger('test', () => {});
const noSleep = async () => {};
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });

const PAPER = '0x598da152e4648d52cfea1bfc3c671f026772da54';

describe.skipIf(!url)('risk job (Postgres)', () => {
  let prisma: PrismaClient;

  async function seed(chainId: string, address: string, liquidityUsd: number | null) {
    const token = await prisma.token.create({ data: { chainId, address, symbol: address.slice(0, 4), firstSeenSource: 'test' } });
    await prisma.pair.create({
      data: {
        chainId,
        address: `pair-${address}`,
        baseTokenId: token.id,
        quoteTokenAddress: 'q',
        isPrimary: true,
        pairCreatedAt: new Date(Date.now() - 3 * 60 * 60_000),
        marketUpdatedAt: new Date(),
        liquidityUsd,
        volumeH24: 10_000,
        priceUsd: 1,
        txns: { h24: { buys: 40, sells: 30, buyers: 20, sellers: 15 } },
      },
    });
    return token.id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await syncChains(prisma);
  });
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "RiskAssessment", "TokenCheck", "MarketSnapshot", "Pair", "Token", "ProviderHealth", "JobLease", "ScanRun", "ScoringConfig" CASCADE');
  });

  it('runs GoPlus checks, stores them, scores the token, and schedules rechecks by outcome', async () => {
    const paperId = await seed('base', PAPER, 60_000);
    const solId = await seed('solana', 'So1NotIndexedYet1111111111111111111111111111', 30_000);
    const hyperId = await seed('hyperevm', '0x00000000000000000000000000000000000000aa', 30_000);
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (u) => {
      urls.push(u);
      return u.includes(PAPER) ? ok(paper) : ok({ code: 1, message: 'ok', result: {} });
    };

    const r = await runRiskJob({ prisma, logger: quiet, trigger: 'test', fetchImpl, sleep: noSleep });
    expect(r).toMatchObject({ status: 'ok', checked: 1, notIndexed: 1, unsupported: 1 });
    expect(urls.some((u) => u.includes('hyperevm') || u.includes('/999'))).toBe(false);

    const paperTok = await prisma.token.findUniqueOrThrow({ where: { id: paperId }, include: { checks: true } });
    expect(paperTok.checks.find((c) => c.checkId === 'liq.lp_control')?.status).toBe('flagged');
    expect(paperTok.riskScore).toBeGreaterThan(0);
    expect(paperTok.riskLevel).toBeTruthy();
    expect(paperTok.momentumScore).not.toBeNull();
    const detail = paperTok.riskDetail as { results: Array<{ checkId: string; status: string }> };
    expect(detail.results.find((x) => x.checkId === 'mkt.bundled_buys')?.status).toBe('not_checked');
    // Answered → recheck in ~12h.
    expect(paperTok.contractNextCheckAt!.getTime() - Date.now()).toBeGreaterThan(11 * 60 * 60_000);

    // Not indexed → retry in ~20 min, and its contract checks read "not checked", not "passed".
    const solTok = await prisma.token.findUniqueOrThrow({ where: { id: solId } });
    expect(solTok.contractNextCheckAt!.getTime() - Date.now()).toBeLessThan(30 * 60_000);
    const solDetail = solTok.riskDetail as { results: Array<{ checkId: string; status: string }>; summary: { incomplete: boolean } };
    expect(solDetail.results.find((x) => x.checkId === 'sol.mint_authority')?.status).toBe('not_checked');
    expect(solDetail.summary.incomplete).toBe(true);

    // Unsupported chain → parked for a week, still assessed on market data.
    const hyper = await prisma.token.findUniqueOrThrow({ where: { id: hyperId } });
    expect(hyper.contractNextCheckAt!.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60_000);
    expect(hyper.riskScore).not.toBeNull();

    // A second run finds nothing due.
    const again = await runRiskJob({ prisma, logger: quiet, trigger: 'test', fetchImpl, sleep: noSleep });
    expect(again.checked + again.notIndexed + again.unsupported).toBe(0);
  });

  it('writes assessment history only when the verdict changes', async () => {
    const id = await seed('base', PAPER, 60_000);
    const now = new Date();
    await assessTokens(prisma, [id], { now });
    await assessTokens(prisma, [id], { now: new Date(now.getTime() + 60_000) });
    expect(await prisma.riskAssessment.count({ where: { tokenId: id } })).toBe(1);
    await prisma.pair.updateMany({ where: { baseTokenId: id }, data: { liquidityUsd: 2_000 } });
    await assessTokens(prisma, [id], { now: new Date(now.getTime() + 120_000) });
    expect(await prisma.riskAssessment.count({ where: { tokenId: id } })).toBe(2);
  });

  it('applies a stored scoring config, and ignores an invalid one', async () => {
    const id = await seed('base', PAPER, 3_000); // liq.depth → high
    await assessTokens(prisma, [id]);
    const before = (await prisma.token.findUniqueOrThrow({ where: { id } })).riskScore!;

    const cfg = (await import('@outis/shared')).DEFAULT_SCORING_CONFIG;
    await prisma.scoringConfig.create({ data: { key: 'default', config: { ...cfg, risk: { ...cfg.risk, severityPoints: { ...cfg.risk.severityPoints, high: 90 } } } } });
    await assessTokens(prisma, [id]);
    const after = (await prisma.token.findUniqueOrThrow({ where: { id } })).riskScore!;
    expect(after).toBeGreaterThan(before);

    await prisma.scoringConfig.update({ where: { key: 'default' }, data: { config: { nonsense: true } } });
    await assessTokens(prisma, [id]);
    expect((await prisma.token.findUniqueOrThrow({ where: { id } })).riskScore).toBe(before);
  });
});
