/**
 * Wallet report: positions valued at current prices, entry timing, and
 * evidence-backed connections. No label is ever inferred — connections are
 * stated as the observation that supports them.
 */
import type { PrismaClient } from '@outis/db';
import { getChain } from '@outis/shared';
import { type Position, QUOTE_TOKENS, cashFlows, computePositions, valuePosition } from './positions';

const CO_ENTRY_WINDOW_MS = 10 * 60_000;
const EARLY_MINUTES = 30;

export interface ValuedPosition extends Position {
  token: { symbol: string | null; name: string | null; imageUrl: string | null; riskScore: number | null; riskLevel: string | null; tracked: boolean };
  priceInUnit: number | null;
  priceSource: string | null;
  value: number | null;
  unrealized: number | null;
  /** Rough USD equivalents at TODAY's native price — never historical. */
  usd: { value: number | null; unrealized: number | null; realized: number | null; nativeUsd: number | null };
  entryMinutesAfterLaunch: number | null;
}

export interface Connection {
  kind: 'deployer' | 'co_entry' | 'direct_transfer';
  text: string;
  evidence: Record<string, unknown>;
}

/** Current native-coin USD price on a chain, from our own primary pairs quoted in wrapped native. */
export async function nativeUsdPrice(prisma: PrismaClient, chainId: string): Promise<number | null> {
  const wrapped = Object.entries(QUOTE_TOKENS[chainId] ?? {}).filter(([, q]) => q.unit === 'native').map(([a]) => a);
  if (wrapped.length === 0) return null;
  const pairs = await prisma.pair.findMany({
    where: { chainId, quoteTokenAddress: { in: wrapped }, priceUsd: { gt: 0 }, priceNative: { gt: 0 }, marketUpdatedAt: { gte: new Date(Date.now() - 2 * 60 * 60_000) } },
    select: { priceUsd: true, priceNative: true },
    take: 200,
  });
  const ratios = pairs.map((p) => p.priceUsd! / p.priceNative!).sort((a, b) => a - b);
  if (ratios.length < 3) return null;
  return ratios[Math.floor(ratios.length / 2)]; // median: robust to a few mispriced pools
}

export async function walletReport(prisma: PrismaClient, walletId: string) {
  const wallet = await prisma.trackedWallet.findUniqueOrThrow({ where: { id: walletId } });
  const chain = getChain(wallet.chainId);
  const transfers = await prisma.walletTransfer.findMany({ where: { walletId }, orderBy: { blockTime: 'asc' } });
  const positions = computePositions(wallet.chainId, transfers);
  const nativeUsd = await nativeUsdPrice(prisma, wallet.chainId);

  const addrs = positions.map((p) => p.tokenAddress);
  const tokens = await prisma.token.findMany({
    where: { chainId: wallet.chainId, address: { in: addrs } },
    include: { pairs: { where: { isPrimary: true }, take: 1 } },
  });
  const byAddr = new Map(tokens.map((t) => [t.address, t]));
  const wrapped = new Set(Object.entries(QUOTE_TOKENS[wallet.chainId] ?? {}).filter(([, q]) => q.unit === 'native').map(([a]) => a));

  const valued: ValuedPosition[] = positions.map((p) => {
    const t = byAddr.get(p.tokenAddress);
    const pair = t?.pairs[0];
    let priceInUnit: number | null = null;
    let priceSource: string | null = null;
    if (pair && p.unit === 'usd' && pair.priceUsd !== null) {
      priceInUnit = pair.priceUsd;
      priceSource = 'primary pair, USD';
    } else if (pair && p.unit === 'native') {
      if (pair.priceNative !== null && wrapped.has(pair.quoteTokenAddress)) {
        priceInUnit = pair.priceNative;
        priceSource = 'primary pair, native quote';
      } else if (pair.priceUsd !== null && nativeUsd) {
        priceInUnit = pair.priceUsd / nativeUsd;
        priceSource = 'primary pair USD ÷ native price (estimate)';
      }
    }
    const v = valuePosition(p, priceInUnit);
    const toUsd = (x: number | null) => (x === null ? null : p.unit === 'usd' ? x : nativeUsd ? x * nativeUsd : null);
    const entry = p.firstEntryAt && pair?.pairCreatedAt ? (p.firstEntryAt.getTime() - pair.pairCreatedAt.getTime()) / 60_000 : null;
    return {
      ...p,
      token: { symbol: t?.symbol ?? p.symbol, name: t?.name ?? null, imageUrl: t?.imageUrl ?? null, riskScore: t?.riskScore ?? null, riskLevel: t?.riskLevel ?? null, tracked: Boolean(t) },
      priceInUnit,
      priceSource,
      value: v.value,
      unrealized: v.unrealized,
      usd: { value: toUsd(v.value), unrealized: toUsd(v.unrealized), realized: toUsd(p.realized), nativeUsd },
      entryMinutesAfterLaunch: entry === null ? null : Math.round(entry),
    };
  });

  // Summary — only sums what is known, and says how much is not.
  const closed = valued.filter((p) => p.soldQty > 0 && p.realized !== null);
  const sum = (xs: Array<number | null>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  const summary = {
    positions: valued.length,
    open: valued.filter((p) => p.netQty > 0).length,
    completePositions: valued.filter((p) => p.complete).length,
    realizedNative: sum(valued.filter((p) => p.unit === 'native').map((p) => p.realized)),
    realizedUsdStable: sum(valued.filter((p) => p.unit === 'usd').map((p) => p.realized)),
    unrealizedKnownNative: sum(valued.filter((p) => p.unit === 'native').map((p) => p.unrealized)),
    winRate: closed.length ? closed.filter((p) => (p.realized ?? 0) > 0).length / closed.length : null,
    closedWithKnownPnl: closed.length,
    earlyEntries: valued.filter((p) => p.entryMinutesAfterLaunch !== null && p.entryMinutesAfterLaunch <= EARLY_MINUTES).length,
    nativeSymbol: chain?.nativeAsset.symbol ?? 'native',
    nativeUsd,
  };

  const flows = cashFlows(wallet.chainId, chain?.nativeAsset.symbol ?? 'native', transfers);
  return { wallet, chain: chain ? { id: chain.id, name: chain.displayName, family: chain.family } : null, positions: valued, flows, summary, transfers: transfers.slice(-200).reverse(), connections: await connections(prisma, walletId) };
}

export async function connections(prisma: PrismaClient, walletId: string): Promise<Connection[]> {
  const w = await prisma.trackedWallet.findUniqueOrThrow({ where: { id: walletId } });
  const out: Connection[] = [];

  // 1. Deployer: GoPlus records this address as a token's creator.
  const created = await prisma.tokenCheck.findMany({
    where: { checkId: { in: ['evm.creator_history', 'holders.creator'] }, evidence: { path: ['creator_address'], equals: w.address }, token: { chainId: w.chainId } },
    include: { token: { select: { symbol: true, address: true } } },
    distinct: ['tokenId'],
  });
  for (const c of created) {
    out.push({ kind: 'deployer', text: `Deployed ${c.token.symbol ?? c.token.address} (GoPlus creator record).`, evidence: { token: c.token.address, source: 'goplus', observedAt: c.observedAt } });
  }

  // 2. Co-entries: another tracked wallet's first buy of the same token within 10 minutes.
  const mine = await prisma.walletTransfer.groupBy({ by: ['tokenAddress'], where: { walletId, direction: 'in', tokenAddress: { not: 'native' } }, _min: { blockTime: true } });
  if (mine.length > 0) {
    const others = await prisma.walletTransfer.groupBy({
      by: ['walletId', 'tokenAddress'],
      where: { chainId: w.chainId, walletId: { not: walletId }, direction: 'in', tokenAddress: { in: mine.map((m) => m.tokenAddress) } },
      _min: { blockTime: true },
    });
    const otherWallets = new Map((await prisma.trackedWallet.findMany({ where: { id: { in: [...new Set(others.map((o) => o.walletId))] } } })).map((x) => [x.id, x]));
    const mineAt = new Map(mine.map((m) => [m.tokenAddress, m._min.blockTime!]));
    const grouped = new Map<string, Array<{ token: string; gapSec: number }>>();
    for (const o of others) {
      const a = mineAt.get(o.tokenAddress);
      if (!a || !o._min.blockTime) continue;
      const gap = Math.abs(a.getTime() - o._min.blockTime.getTime());
      if (gap > CO_ENTRY_WINDOW_MS) continue;
      const list = grouped.get(o.walletId) ?? [];
      list.push({ token: o.tokenAddress, gapSec: Math.round(gap / 1000) });
      grouped.set(o.walletId, list);
    }
    for (const [otherId, list] of grouped) {
      const other = otherWallets.get(otherId);
      out.push({
        kind: 'co_entry',
        text: `${other?.label ?? other?.address} first bought ${list.length} of the same token(s) within 10 minutes of this wallet.`,
        evidence: { walletId: otherId, address: other?.address, tokens: list },
      });
    }
  }

  // 3. Direct transfers between tracked wallets.
  const tracked = await prisma.trackedWallet.findMany({ where: { chainId: w.chainId, id: { not: walletId } }, select: { id: true, address: true, label: true } });
  if (tracked.length > 0) {
    const direct = await prisma.walletTransfer.groupBy({
      by: ['counterparty'],
      where: { walletId, counterparty: { in: tracked.map((t) => t.address) } },
      _count: { _all: true },
    });
    for (const d of direct) {
      const t = tracked.find((x) => x.address === d.counterparty);
      out.push({ kind: 'direct_transfer', text: `${d._count._all} direct token transfer(s) with ${t?.label ?? t?.address}.`, evidence: { walletId: t?.id, address: d.counterparty, count: d._count._all } });
    }
  }
  return out;
}
