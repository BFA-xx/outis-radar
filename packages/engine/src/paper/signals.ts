/**
 * Signal rules and their bookkeeping.
 *
 * A signal is recorded the first time a token matches a rule, from the values
 * it had at that moment (called from assessTokens, right after the scores are
 * computed). Several rules run side by side so they can be compared — e.g.
 * does filtering on risk actually improve outcomes?
 */
import type { PrismaClient } from '@outis/db';
import { type AlertPrefs, DEFAULT_ALERT_PREFS, matchesDiscovery } from '@outis/shared';
import { DEFAULT_COSTS, type Observation, evaluateSignal } from './math';

export interface SignalRule {
  id: string;
  label: string;
  description: string;
  prefs: AlertPrefs;
  /** Custom matcher, used instead of the discovery thresholds in `prefs`. */
  match?: (s: SignalInput) => boolean;
}

/** A launchpad token that moved off its bonding curve within this window counts as "just graduated". */
export const GRADUATION_WINDOW_MINUTES = 60;

const base = DEFAULT_ALERT_PREFS;
export const SIGNAL_RULES: SignalRule[] = [
  {
    id: 'strict',
    label: 'Strict (alert defaults)',
    description: 'Liquidity ≥ $20K, volume ≥ $10K, age ≤ 6h, momentum ≥ 60, risk ≤ 44 with ≥ 60% of checks run.',
    prefs: base,
  },
  {
    id: 'momentum',
    label: 'Momentum only',
    description: 'Momentum ≥ 60, liquidity ≥ $10K, age ≤ 6h. Ignores risk — the control group for the risk filter.',
    prefs: { ...base, discovery: { ...base.discovery, minLiquidityUsd: 10_000, minVolumeH24: 0, maxRisk: 100, minRiskCoverage: 0 } },
  },
  {
    id: 'low_risk',
    label: 'Low risk',
    description: 'Risk ≤ 19 with ≥ 60% of checks run, liquidity ≥ $10K, age ≤ 6h. Ignores momentum.',
    prefs: { ...base, discovery: { ...base.discovery, minLiquidityUsd: 10_000, minVolumeH24: 0, minMomentum: 0, maxRisk: 19 } },
  },
  {
    id: 'graduated',
    label: 'Launchpad graduates',
    description: `Any launchpad token (pump.fun, four.meme, …) seen within ${GRADUATION_WINDOW_MINUTES} min of graduating to an open pool, liquidity ≥ $5K. No momentum or risk filter — tests whether graduation alone is an edge.`,
    prefs: base,
    match: (s) => s.graduatedMinutesAgo !== null && s.graduatedMinutesAgo !== undefined && s.graduatedMinutesAgo <= GRADUATION_WINDOW_MINUTES && (s.liquidityUsd ?? 0) >= 5_000,
  },
];

export interface SignalInput {
  tokenId: string;
  pairId: string;
  chainId: string;
  at: Date;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeH24: number | null;
  ageMinutes: number | null;
  momentumScore: number | null;
  riskScore: number | null;
  riskCoverage: number | null;
  /** Minutes since the token graduated from its launchpad; null if it has not (or no launchpad is known). */
  graduatedMinutesAgo?: number | null;
}

/** Which rules does this snapshot of a token match? Pure. */
export function matchingRules(s: SignalInput): SignalRule[] {
  return SIGNAL_RULES.filter(
    (r) =>
      r.match ? r.match(s) : matchesDiscovery(
        { chainId: s.chainId, liquidityUsd: s.liquidityUsd, volumeH24: s.volumeH24, ageMinutes: s.ageMinutes, momentumScore: s.momentumScore, riskScore: s.riskScore, riskCoverage: s.riskCoverage },
        r.prefs,
      ).ok,
  );
}

export async function recordSignals(prisma: PrismaClient, inputs: SignalInput[]): Promise<number> {
  const rows = inputs.flatMap((s) =>
    matchingRules(s).map((r) => ({
      rule: r.id,
      tokenId: s.tokenId,
      pairId: s.pairId,
      chainId: s.chainId,
      firedAt: s.at,
      priceUsd: s.priceUsd,
      liquidityUsd: s.liquidityUsd,
      momentumScore: s.momentumScore,
      riskScore: s.riskScore,
      riskCoverage: s.riskCoverage,
      ageMinutes: s.ageMinutes,
    })),
  );
  if (!rows.length) return 0;
  // First match per (rule, token) only: later re-matches are not new signals.
  return (await prisma.signal.createMany({ data: rows, skipDuplicates: true })).count;
}

/** Observations for a pair, all sources, as a time series. */
export async function observationsFor(prisma: PrismaClient, pairId: string, from: Date, to: Date): Promise<Observation[]> {
  const rows = await prisma.marketSnapshot.findMany({
    where: { pairId, observedAt: { gte: from, lte: to } },
    orderBy: { observedAt: 'asc' },
    select: { observedAt: true, priceUsd: true, liquidityUsd: true },
  });
  return rows.map((r) => ({ at: r.observedAt, priceUsd: r.priceUsd, liquidityUsd: r.liquidityUsd }));
}

/** Update every still-tracking signal from the observations recorded since it fired. */
export async function evaluateSignals(prisma: PrismaClient, now = new Date(), limit = 500): Promise<{ evaluated: number; finished: number }> {
  const tracking = await prisma.signal.findMany({ where: { status: 'tracking' }, orderBy: { lastEvaluatedAt: { sort: 'asc', nulls: 'first' } }, take: limit });
  let finished = 0;
  for (const s of tracking) {
    const obs = await observationsFor(prisma, s.pairId, s.firedAt, new Date(s.firedAt.getTime() + 27 * 60 * 60_000));
    const e = evaluateSignal(s.firedAt, obs, now, DEFAULT_COSTS);
    if (e.done) finished++;
    await prisma.signal.update({
      where: { id: s.id },
      data: {
        entryAt: e.entry?.at ?? null,
        entryPrice: e.entry?.priceUsd ?? null,
        entryLiquidity: e.entry?.liquidityUsd ?? null,
        outcomes: e.outcomes as object,
        mfePct: e.mfePct,
        maePct: e.maePct,
        collapsedAt: e.collapsedAt,
        status: e.done ? 'done' : 'tracking',
        lastEvaluatedAt: now,
      },
    });
  }
  return { evaluated: tracking.length, finished };
}
