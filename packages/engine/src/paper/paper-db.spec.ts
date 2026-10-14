/** Signals + paper trades against a real Postgres (DATABASE_URL_TEST). */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncChains } from '../persist';
import { assessTokens } from '../risk/assess';
import { performanceReport, paperReport } from './report';
import { evaluateSignals } from './signals';
import { PaperTradeError, cashAvailable, closePaperTrade, evaluatePaperTrades, openPaperTrade } from './trades';

const envFile = resolve(__dirname, '../../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL_TEST;
const cfg = { startingBalanceUsd: 1_000, defaultSizeUsd: 100, feeBps: 100, slippageBps: 50 };

describe.skipIf(!url)('paper trading (Postgres)', () => {
  let prisma: PrismaClient;
  const now = new Date();
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await syncChains(prisma);
  });
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Signal", "PaperTrade", "PortfolioSnapshot", "MarketSnapshot", "RiskAssessment", "TokenCheck", "Pair", "Token" CASCADE');
  });

  async function tokenWithPair(o: { liq?: number; price?: number; updated?: Date; ageMin?: number } = {}) {
    const t = await prisma.token.create({ data: { chainId: 'solana', address: `Mint${Math.random().toString(36).slice(2, 12)}`, symbol: 'TST', firstSeenSource: 'test' } });
    const p = await prisma.pair.create({
      data: {
        chainId: 'solana', address: `pair-${t.id}`, baseTokenId: t.id, quoteTokenAddress: 'So11111111111111111111111111111111111111112', isPrimary: true,
        priceUsd: o.price ?? 1, liquidityUsd: o.liq ?? 50_000, volumeH24: 40_000, volumeH1: 20_000, volumeH6: 30_000, volumeM5: 2_000,
        txns: { h1: { buys: 80, sells: 20 }, h24: { buys: 300, sells: 200, buyers: 150, sellers: 90 } }, buyersH24: 300, priceChangeH1: 40,
        pairCreatedAt: minsAgo(o.ageMin ?? 90), marketUpdatedAt: o.updated ?? now,
      },
    });
    return { t, p };
  }
  const snap = (pairId: string, at: Date, price: number, liq = 50_000) =>
    prisma.marketSnapshot.create({ data: { pairId, source: 'test', reason: 'refresh', observedAt: at, bucket: new Date(Math.floor(at.getTime() / 60_000) * 60_000), priceUsd: price, liquidityUsd: liq } });

  it('assessment records a signal once per rule, with the values it had then', async () => {
    const { t } = await tokenWithPair();
    await assessTokens(prisma, [t.id], { now: minsAgo(300) });
    const first = await prisma.signal.findMany({ where: { tokenId: t.id } });
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((s) => s.firedAt.getTime() === minsAgo(300).getTime())).toBe(true);
    await assessTokens(prisma, [t.id], { now: minsAgo(200) });
    expect(await prisma.signal.count({ where: { tokenId: t.id } })).toBe(first.length); // no re-fire
  });

  it('a fresh graduation fires the "graduated" rule without any score filter', async () => {
    const { t } = await tokenWithPair({ liq: 8_000 });
    await prisma.token.update({ where: { id: t.id }, data: { launchpad: 'pumpfun', launchpadStage: 'graduated', graduatedAt: minsAgo(30) } });
    await assessTokens(prisma, [t.id], { now });
    expect((await prisma.signal.findMany({ where: { tokenId: t.id } })).map((s) => s.rule)).toContain('graduated');
  });

  it('follows a signal through later snapshots into a report', async () => {
    const { t, p } = await tokenWithPair();
    await prisma.signal.create({ data: { rule: 'strict', tokenId: t.id, pairId: p.id, chainId: 'solana', firedAt: minsAgo(400), priceUsd: 1, momentumScore: 70, riskScore: 10, ageMinutes: 20 } });
    await snap(p.id, minsAgo(400), 1); // the triggering price — must not be the entry
    await snap(p.id, minsAgo(390), 1.1); // entry
    await snap(p.id, minsAgo(329), 1.65); // +1h  → +50%
    // +4h (target 150 min ago, tolerance 60) passed with no observation → no_data
    const r = await evaluateSignals(prisma, now);
    expect(r.evaluated).toBe(1);
    const s = await prisma.signal.findFirstOrThrow();
    expect(s.entryPrice).toBe(1.1);
    const out = s.outcomes as Record<string, { status: string; returnPct: number }>;
    expect(out['1h']).toMatchObject({ status: 'ok' });
    expect(out['1h'].returnPct).toBeCloseTo(50);
    expect(out['4h'].status).toBe('no_data'); // no observation near +4h
    expect(out['24h'].status).toBe('pending'); // genuinely not reached yet
    const rep = await performanceReport(prisma, { horizon: '1h' });
    const strict = rep.rules.find((x) => x.id === 'strict')!;
    expect(strict.byHorizon['1h'].observed.n).toBe(1);
    expect(strict.byHorizon['4h'].noData).toBe(1);
    expect(strict.byHorizon['4h'].pessimistic.worstPct).toBe(-100);
  });

  it('refuses stale prices and trades larger than the paper cash', async () => {
    const stale = await tokenWithPair({ updated: minsAgo(45) });
    await expect(openPaperTrade(prisma, { tokenId: stale.t.id, sizeUsd: 100 }, cfg, now)).rejects.toThrow(/30 minutes old/);
    const fresh = await tokenWithPair();
    await expect(openPaperTrade(prisma, { tokenId: fresh.t.id, sizeUsd: 5_000 }, cfg, now)).rejects.toBeInstanceOf(PaperTradeError);
  });

  it('opens, hits take-profit on a later snapshot, books PnL net of costs', async () => {
    const { t, p } = await tokenWithPair({ price: 1, liq: 50_000 });
    const trade = await openPaperTrade(prisma, { tokenId: t.id, sizeUsd: 100, takeProfitPct: 30, stopLossPct: 20 }, cfg, now);
    expect(trade.entryImpactPct).toBeCloseTo(100 / 25_100 * 100, 3);
    expect(await cashAvailable(prisma, cfg)).toBe(900);
    await snap(p.id, new Date(now.getTime() + 10 * 60_000), 1.4);
    const r = await evaluatePaperTrades(prisma, new Date(now.getTime() + 11 * 60_000));
    expect(r.closed).toBe(1);
    const closed = await prisma.paperTrade.findFirstOrThrow();
    expect(closed).toMatchObject({ status: 'closed', exitReason: 'take_profit', exitPrice: 1.4 });
    expect(closed.returnPct!).toBeLessThan(40); // costs bite
    expect(closed.returnPct!).toBeGreaterThan(30);
    expect(await cashAvailable(prisma, cfg)).toBeCloseTo(1_000 + closed.pnlUsd!);
    const rep = await paperReport(prisma, cfg);
    expect(rep.closedStats.n).toBe(1);
  });

  it('manual close uses the latest observed price', async () => {
    const { t, p } = await tokenWithPair({ price: 2 });
    const trade = await openPaperTrade(prisma, { tokenId: t.id, sizeUsd: 100 }, cfg, now);
    await prisma.pair.update({ where: { id: p.id }, data: { priceUsd: 1, marketUpdatedAt: new Date() } });
    const c = await closePaperTrade(prisma, trade.id);
    expect(c.exitReason).toBe('manual');
    expect(c.returnPct!).toBeLessThan(-50);
  });
});
