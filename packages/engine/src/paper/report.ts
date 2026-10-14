/**
 * Performance report: what signals and paper trades actually returned.
 *
 * Read with care, and the report says so: returns are net of the modelled
 * costs; "no data" outcomes (tokens that stopped reporting prices) are shown
 * separately AND folded into a pessimistic figure as −100%, because tokens
 * that vanish are rarely the winners; a sample under 30 is flagged as noise.
 */
import type { PrismaClient } from '@outis/db';
import { getLaunchpad } from '@outis/shared';
import { HORIZONS, type HorizonKey, type HorizonOutcome, type Stats, maxDrawdownPct, stats } from './math';
import { SIGNAL_RULES } from './signals';
import { type PaperConfig, portfolioState } from './trades';

export const MIN_MEANINGFUL_SAMPLE = 30;

interface Bucketed {
  bucket: string;
  stats: Stats;
}

function bucketOf(kind: 'age' | 'momentum' | 'risk', v: number | null): string {
  if (v === null) return 'unknown';
  if (kind === 'age') return v < 30 ? '< 30m' : v < 120 ? '30m–2h' : v < 360 ? '2–6h' : '≥ 6h';
  if (kind === 'momentum') return v < 50 ? '< 50' : v < 60 ? '50–59' : v < 70 ? '60–69' : '≥ 70';
  return v < 20 ? '0–19' : v < 45 ? '20–44' : v < 70 ? '45–69' : '≥ 70';
}

export async function performanceReport(prisma: PrismaClient, opts: { horizon?: HorizonKey; since?: Date } = {}) {
  const horizon = opts.horizon ?? '4h';
  const signals = await prisma.signal.findMany({ where: opts.since ? { firedAt: { gte: opts.since } } : {}, orderBy: { firedAt: 'desc' }, take: 20_000 });

  const outcomeOf = (s: (typeof signals)[number], h: HorizonKey) => ((s.outcomes ?? {}) as unknown as Record<string, HorizonOutcome>)[h];
  const realized = (o: HorizonOutcome | undefined) => (o && (o.status === 'ok' || o.status === 'collapsed') && o.netReturnPct !== null ? o.netReturnPct : null);

  // Launchpad origin is a property of the token, not of the moment, so the current tag is fine here.
  const launchpadOf = new Map(
    (await prisma.token.findMany({ where: { id: { in: [...new Set(signals.map((s) => s.tokenId))] } }, select: { id: true, launchpad: true } })).map((t) => [t.id, t.launchpad]),
  );

  const rules = SIGNAL_RULES.map((r) => {
    const mine = signals.filter((s) => s.rule === r.id);
    const byHorizon = Object.fromEntries(
      HORIZONS.map((h) => {
        const outs = mine.map((s) => outcomeOf(s, h.key));
        const observed = outs.map(realized).filter((x): x is number => x !== null);
        const noData = outs.filter((o) => o?.status === 'no_data').length;
        const pending = outs.filter((o) => !o || o.status === 'pending').length;
        const collapsed = outs.filter((o) => o?.status === 'collapsed').length;
        return [
          h.key,
          {
            observed: stats(observed),
            pessimistic: stats([...observed, ...Array(noData).fill(-100)]),
            noData,
            pending,
            collapsed,
          },
        ];
      }),
    );
    const at = (k: 'chainId' | 'age' | 'momentum' | 'risk' | 'launchpad'): Bucketed[] => {
      const groups = new Map<string, number[]>();
      for (const s of mine) {
        const r = realized(outcomeOf(s, horizon));
        if (r === null) continue;
        const key = k === 'chainId' ? s.chainId : k === 'launchpad' ? (getLaunchpad(launchpadOf.get(s.tokenId))?.name ?? 'none known') : bucketOf(k, k === 'age' ? s.ageMinutes : k === 'momentum' ? s.momentumScore : s.riskScore);
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.entries()].map(([bucket, xs]) => ({ bucket, stats: stats(xs) })).sort((a, b) => b.stats.n - a.stats.n);
    };
    const mfe = mine.map((s) => s.mfePct).filter((x): x is number => x !== null);
    const mae = mine.map((s) => s.maePct).filter((x): x is number => x !== null);
    return {
      id: r.id,
      label: r.label,
      description: r.description,
      signals: mine.length,
      byHorizon,
      breakdown: { chain: at('chainId'), launchpad: at('launchpad'), age: at('age'), momentum: at('momentum'), risk: at('risk') },
      avgMfePct: mfe.length ? mfe.reduce((a, b) => a + b, 0) / mfe.length : null,
      avgMaePct: mae.length ? mae.reduce((a, b) => a + b, 0) / mae.length : null,
    };
  });

  const recent = signals.slice(0, 50);
  const tokens = new Map((await prisma.token.findMany({ where: { id: { in: recent.map((s) => s.tokenId) } }, select: { id: true, address: true, symbol: true } })).map((t) => [t.id, t]));
  return {
    horizon,
    minMeaningfulSample: MIN_MEANINGFUL_SAMPLE,
    firstSignalAt: signals.length ? signals[signals.length - 1].firedAt : null,
    rules,
    recent: recent.map((s) => ({ ...s, address: tokens.get(s.tokenId)?.address ?? null, symbol: tokens.get(s.tokenId)?.symbol ?? null })),
  };
}

export async function paperReport(prisma: PrismaClient, cfg: PaperConfig) {
  const [trades, curve, state] = await Promise.all([
    prisma.paperTrade.findMany({ orderBy: { openedAt: 'desc' }, take: 500 }),
    prisma.portfolioSnapshot.findMany({ orderBy: { at: 'asc' }, take: 5000 }),
    portfolioState(prisma, cfg),
  ]);
  const addresses = new Map((await prisma.token.findMany({ where: { id: { in: trades.map((t) => t.tokenId) } }, select: { id: true, address: true } })).map((t) => [t.id, t.address]));
  const closed = trades.filter((t) => t.status === 'closed' && t.returnPct !== null);
  const byChain = new Map<string, number[]>();
  for (const t of closed) byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t.returnPct!]);
  const equity = [cfg.startingBalanceUsd, ...curve.map((c) => c.equityUsd), state.equityUsd];
  return {
    config: cfg,
    state,
    closedStats: stats(closed.map((t) => t.returnPct!)),
    byChain: [...byChain.entries()].map(([chainId, xs]) => ({ chainId, stats: stats(xs) })),
    byExitReason: Object.entries(closed.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.exitReason ?? 'unknown']: (acc[t.exitReason ?? 'unknown'] ?? 0) + 1 }), {})).map(([reason, count]) => ({ reason, count })),
    maxDrawdownPct: maxDrawdownPct(equity),
    curve: curve.map((c) => ({ at: c.at, equityUsd: c.equityUsd })),
    trades: trades.map((t) => ({ ...t, address: addresses.get(t.tokenId) ?? null, mark: state.marks.find((m) => m.id === t.id) ?? null })),
  };
}
