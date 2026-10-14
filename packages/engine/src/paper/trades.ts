/**
 * Paper trades: open at the latest observed price (with its age shown), close
 * by rule (take profit / stop loss / max hold / liquidity collapse) from the
 * observations that follow, or by hand. No order is ever sent anywhere.
 */
import type { PrismaClient } from '@outis/db';
import { type CostModel, findExit, netReturn, priceImpact } from './math';
import { observationsFor } from './signals';

export interface PaperConfig {
  startingBalanceUsd: number;
  defaultSizeUsd: number;
  feeBps: number;
  slippageBps: number;
}

export function loadPaperConfig(env: Record<string, string | undefined> = process.env): PaperConfig {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    startingBalanceUsd: n('PAPER_START_BALANCE_USD', 10_000),
    defaultSizeUsd: n('PAPER_DEFAULT_SIZE_USD', 100),
    feeBps: Math.round(n('PAPER_FEE_BPS', 100)),
    slippageBps: Math.round(n('PAPER_SLIPPAGE_BPS', 50)),
  };
}

/** A price older than this cannot be used to open a trade. */
const MAX_ENTRY_PRICE_AGE_MS = 30 * 60_000;

export class PaperTradeError extends Error {}

export async function openPaperTrade(
  prisma: PrismaClient,
  input: { tokenId: string; sizeUsd: number; takeProfitPct?: number | null; stopLossPct?: number | null; maxHoldMinutes?: number | null; feeBps?: number; slippageBps?: number; note?: string | null; signalId?: string | null },
  cfg: PaperConfig,
  now = new Date(),
) {
  const token = await prisma.token.findUnique({ where: { id: input.tokenId }, include: { pairs: { where: { isPrimary: true }, take: 1 } } });
  const pair = token?.pairs[0];
  if (!token || !pair) throw new PaperTradeError('Token has no tracked pair.');
  if (pair.priceUsd === null || !pair.marketUpdatedAt) throw new PaperTradeError('No price observed for this token yet.');
  if (now.getTime() - pair.marketUpdatedAt.getTime() > MAX_ENTRY_PRICE_AGE_MS) {
    throw new PaperTradeError('The latest price is over 30 minutes old — wait for a fresh scan rather than trade on stale data.');
  }
  const cash = await cashAvailable(prisma, cfg);
  if (input.sizeUsd > cash) throw new PaperTradeError(`Not enough paper cash: $${cash.toFixed(2)} available.`);
  const impact = priceImpact(input.sizeUsd, pair.liquidityUsd);
  return prisma.paperTrade.create({
    data: {
      tokenId: token.id,
      pairId: pair.id,
      chainId: token.chainId,
      symbol: token.symbol,
      signalId: input.signalId ?? null,
      sizeUsd: input.sizeUsd,
      feeBps: input.feeBps ?? cfg.feeBps,
      slippageBps: input.slippageBps ?? cfg.slippageBps,
      takeProfitPct: input.takeProfitPct ?? null,
      stopLossPct: input.stopLossPct ?? null,
      maxHoldMinutes: input.maxHoldMinutes ?? null,
      openedAt: now,
      entryPrice: pair.priceUsd,
      entryObservedAt: pair.marketUpdatedAt,
      entryLiquidity: pair.liquidityUsd,
      entryImpactPct: (impact ?? 0) * 100,
      note: input.note ?? null,
    },
  });
}

type Trade = NonNullable<Awaited<ReturnType<PrismaClient['paperTrade']['findUnique']>>>;
const costsOf = (t: Trade): CostModel => ({ sizeUsd: t.sizeUsd, feeBps: t.feeBps, slippageBps: t.slippageBps });

function closeData(t: Trade, exit: { at: Date; price: number; liquidityUsd: number | null; reason: string }, mfe: number | null, mae: number | null, now: Date) {
  const r = netReturn(t.entryPrice, exit.price, t.entryLiquidity, exit.liquidityUsd, costsOf(t));
  return {
    status: 'closed',
    closedAt: now,
    exitPrice: exit.price,
    exitObservedAt: exit.at,
    exitImpactPct: r.exitImpactPct ?? 0,
    exitReason: exit.reason,
    returnPct: exit.reason === 'collapsed' ? -100 : r.netPct,
    pnlUsd: exit.reason === 'collapsed' ? -t.sizeUsd : (t.sizeUsd * r.netPct) / 100,
    mfePct: mfe,
    maePct: mae,
  };
}

/** Close one trade now at the latest observed price. */
export async function closePaperTrade(prisma: PrismaClient, id: string, now = new Date()) {
  const t = await prisma.paperTrade.findUnique({ where: { id } });
  if (!t || t.status !== 'open') throw new PaperTradeError('No open trade with that id.');
  const pair = await prisma.pair.findUnique({ where: { id: t.pairId } });
  if (!pair?.priceUsd || !pair.marketUpdatedAt) throw new PaperTradeError('No current price to close at.');
  const ex = await excursion(prisma, t, now);
  return prisma.paperTrade.update({ where: { id }, data: closeData(t, { at: pair.marketUpdatedAt, price: pair.priceUsd, liquidityUsd: pair.liquidityUsd, reason: 'manual' }, ex.mfe, ex.mae, now) });
}

async function excursion(prisma: PrismaClient, t: Trade, to: Date) {
  const obs = await observationsFor(prisma, t.pairId, t.entryObservedAt, to);
  const moves = obs.filter((o) => o.at > t.entryObservedAt && o.priceUsd).map((o) => (o.priceUsd! / t.entryPrice - 1) * 100);
  return { obs, mfe: moves.length ? Math.max(...moves) : null, mae: moves.length ? Math.min(...moves) : null };
}

/** Apply exit rules to every open trade. */
export async function evaluatePaperTrades(prisma: PrismaClient, now = new Date()): Promise<{ checked: number; closed: number }> {
  const open = await prisma.paperTrade.findMany({ where: { status: 'open' } });
  let closed = 0;
  for (const t of open) {
    const ex = await excursion(prisma, t, now);
    const exit = findExit(t.entryPrice, t.entryObservedAt, { takeProfitPct: t.takeProfitPct, stopLossPct: t.stopLossPct, maxHoldMinutes: t.maxHoldMinutes }, ex.obs, t.entryLiquidity);
    if (exit) {
      await prisma.paperTrade.update({ where: { id: t.id }, data: closeData(t, exit, ex.mfe, ex.mae, now) });
      closed++;
    } else {
      await prisma.paperTrade.update({ where: { id: t.id }, data: { mfePct: ex.mfe, maePct: ex.mae } });
    }
  }
  return { checked: open.length, closed };
}

export async function cashAvailable(prisma: PrismaClient, cfg: PaperConfig): Promise<number> {
  const [realized, openCost] = await Promise.all([
    prisma.paperTrade.aggregate({ where: { status: 'closed' }, _sum: { pnlUsd: true } }),
    prisma.paperTrade.aggregate({ where: { status: 'open' }, _sum: { sizeUsd: true } }),
  ]);
  return cfg.startingBalanceUsd + (realized._sum.pnlUsd ?? 0) - (openCost._sum.sizeUsd ?? 0);
}

/** Mark open trades to market (net of exit costs) and record an equity point. */
export async function portfolioState(prisma: PrismaClient, cfg: PaperConfig) {
  const open = await prisma.paperTrade.findMany({ where: { status: 'open' } });
  const pairs = new Map((await prisma.pair.findMany({ where: { id: { in: open.map((t) => t.pairId) } } })).map((p) => [p.id, p]));
  let openValue = 0;
  const marks = open.map((t) => {
    const p = pairs.get(t.pairId);
    if (!p?.priceUsd) {
      // No price: valued at cost, and flagged.
      openValue += t.sizeUsd;
      return { id: t.id, priceUsd: null, valueUsd: t.sizeUsd, returnPct: null, stale: true };
    }
    const r = netReturn(t.entryPrice, p.priceUsd, t.entryLiquidity, p.liquidityUsd, costsOf(t));
    const value = t.sizeUsd * (1 + r.netPct / 100);
    openValue += value;
    return { id: t.id, priceUsd: p.priceUsd, valueUsd: value, returnPct: r.netPct, stale: !p.marketUpdatedAt || Date.now() - p.marketUpdatedAt.getTime() > 60 * 60_000 };
  });
  const realized = (await prisma.paperTrade.aggregate({ where: { status: 'closed' }, _sum: { pnlUsd: true } }))._sum.pnlUsd ?? 0;
  const cash = cfg.startingBalanceUsd + realized - open.reduce((s, t) => s + t.sizeUsd, 0);
  return { cashUsd: cash, openValueUsd: openValue, equityUsd: cash + openValue, realizedUsd: realized, marks, openTrades: open.length };
}

export async function snapshotPortfolio(prisma: PrismaClient, cfg: PaperConfig, now = new Date()) {
  const s = await portfolioState(prisma, cfg);
  return prisma.portfolioSnapshot.create({ data: { at: now, equityUsd: s.equityUsd, cashUsd: s.cashUsd, openValueUsd: s.openValueUsd, realizedUsd: s.realizedUsd, openTrades: s.openTrades } });
}
