/**
 * Paper-trading math. Pure functions; every assumption is a parameter.
 *
 * Costs per side = swap fee + extra slippage + price impact. Impact uses the
 * constant-product approximation: a trade of size S into a pool whose quote
 * side holds L/2 moves the price by about S / (L/2 + S). It understates
 * impact on thin concentrated-liquidity pools and is ignored entirely when
 * liquidity is unknown — which is reported, not hidden.
 */

export interface Observation {
  at: Date;
  priceUsd: number | null;
  liquidityUsd: number | null;
}

export interface CostModel {
  sizeUsd: number;
  feeBps: number;
  slippageBps: number;
}

export const DEFAULT_COSTS: CostModel = { sizeUsd: 100, feeBps: 100, slippageBps: 50 };

/** Fractional price impact of a trade of `sizeUsd` in a pool with `liquidityUsd` total liquidity. Null if unknown. */
export function priceImpact(sizeUsd: number, liquidityUsd: number | null): number | null {
  if (liquidityUsd === null || liquidityUsd <= 0) return null;
  const quoteSide = liquidityUsd / 2;
  return sizeUsd / (quoteSide + sizeUsd);
}

/**
 * Net return of buying at `entry` and selling at `exit`, after costs on both sides.
 * Unknown liquidity → impact treated as 0 and `impactKnown: false` is returned.
 */
export function netReturn(entryPrice: number, exitPrice: number, entryLiq: number | null, exitLiq: number | null, c: CostModel) {
  const ie = priceImpact(c.sizeUsd, entryLiq);
  const ix = priceImpact(c.sizeUsd, exitLiq);
  const side = (c.feeBps + c.slippageBps) / 10_000;
  const buyAt = entryPrice * (1 + side + (ie ?? 0));
  const sellAt = exitPrice * (1 - side - (ix ?? 0));
  return {
    grossPct: (exitPrice / entryPrice - 1) * 100,
    netPct: (Math.max(sellAt, 0) / buyAt - 1) * 100,
    entryImpactPct: ie === null ? null : ie * 100,
    exitImpactPct: ix === null ? null : ix * 100,
    impactKnown: ie !== null && ix !== null,
  };
}

export const HORIZONS = [
  { key: '15m', minutes: 15 },
  { key: '1h', minutes: 60 },
  { key: '4h', minutes: 240 },
  { key: '24h', minutes: 1440 },
] as const;
export type HorizonKey = (typeof HORIZONS)[number]['key'];

/** A price "at +1h" must be observed within this window after +1h, else it's no_data. */
const tolerance = (minutes: number) => Math.max(20, minutes * 0.25);
/** Liquidity falling below this fraction of entry liquidity = collapsed (rug / pulled liquidity). */
export const COLLAPSE_FRACTION = 0.1;
/** Entry needs a price observed at least this long after the signal — no buying at the price that triggered it. */
export const ENTRY_DELAY_MS = 60_000;

export interface HorizonOutcome {
  status: 'pending' | 'ok' | 'collapsed' | 'no_data';
  at: string | null;
  price: number | null;
  returnPct: number | null;
  netReturnPct: number | null;
}

export interface SignalEvaluation {
  entry: Observation | null;
  outcomes: Record<HorizonKey, HorizonOutcome>;
  mfePct: number | null;
  maePct: number | null;
  collapsedAt: Date | null;
  done: boolean;
}

/**
 * Follow a signal through observations recorded after it fired.
 * `obs` may contain anything; only observations after the signal are used.
 */
export function evaluateSignal(firedAt: Date, obs: Observation[], now: Date, costs: CostModel = DEFAULT_COSTS): SignalEvaluation {
  const after = obs
    .filter((o) => o.at.getTime() >= firedAt.getTime() + ENTRY_DELAY_MS && o.priceUsd !== null && o.priceUsd > 0)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const entry = after[0] ?? null;
  const pendingAll = Object.fromEntries(HORIZONS.map((h) => [h.key, { status: 'pending', at: null, price: null, returnPct: null, netReturnPct: null }])) as Record<HorizonKey, HorizonOutcome>;
  if (!entry) {
    // No price after the signal yet. If a long time passed, it never traded again.
    const stale = now.getTime() - firedAt.getTime() > 24 * 60 * 60_000 + tolerance(1440) * 60_000;
    if (stale) for (const h of HORIZONS) pendingAll[h.key] = { status: 'no_data', at: null, price: null, returnPct: null, netReturnPct: null };
    return { entry: null, outcomes: pendingAll, mfePct: null, maePct: null, collapsedAt: null, done: stale };
  }

  const entryPrice = entry.priceUsd!;
  const collapse = entry.liquidityUsd !== null ? after.find((o) => o.liquidityUsd !== null && o.liquidityUsd < entry.liquidityUsd! * COLLAPSE_FRACTION) : undefined;
  const collapsedAt = collapse?.at ?? null;

  const outcomes = {} as Record<HorizonKey, HorizonOutcome>;
  for (const h of HORIZONS) {
    const target = entry.at.getTime() + h.minutes * 60_000;
    if (collapsedAt && collapsedAt.getTime() <= target) {
      outcomes[h.key] = { status: 'collapsed', at: collapsedAt.toISOString(), price: 0, returnPct: -100, netReturnPct: -100 };
      continue;
    }
    const hit = after.find((o) => o.at.getTime() >= target && o.at.getTime() <= target + tolerance(h.minutes) * 60_000);
    if (hit) {
      const r = netReturn(entryPrice, hit.priceUsd!, entry.liquidityUsd, hit.liquidityUsd, costs);
      outcomes[h.key] = { status: 'ok', at: hit.at.toISOString(), price: hit.priceUsd, returnPct: r.grossPct, netReturnPct: r.netPct };
    } else if (now.getTime() > target + tolerance(h.minutes) * 60_000) {
      outcomes[h.key] = { status: 'no_data', at: null, price: null, returnPct: null, netReturnPct: null };
    } else {
      outcomes[h.key] = { status: 'pending', at: null, price: null, returnPct: null, netReturnPct: null };
    }
  }

  // Max favourable / adverse excursion over the 24h after entry (gross).
  // Same window the +24h outcome may use, so MAE/MFE and the 24h return can never disagree.
  const window = after.filter((o) => o.at.getTime() <= entry.at.getTime() + (24 * 60 + tolerance(1440)) * 60_000);
  const moves = window.map((o) => (o.priceUsd! / entryPrice - 1) * 100);
  const mfePct = moves.length ? Math.max(...moves) : null;
  const maePct = collapsedAt ? -100 : moves.length ? Math.min(...moves) : null;
  const done = HORIZONS.every((h) => outcomes[h.key].status !== 'pending');
  return { entry, outcomes, mfePct, maePct, collapsedAt, done };
}

export interface ExitRules {
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldMinutes: number | null;
}

/**
 * First exit triggered by observations after entry. Fills at the OBSERVED
 * price that breached the level (not the level itself): with ~10-minute data a
 * stop at −20% can fill at −60%, and pretending otherwise flatters results.
 */
export function findExit(entryPrice: number, entryAt: Date, rules: ExitRules, obs: Observation[], entryLiq: number | null): { at: Date; price: number; liquidityUsd: number | null; reason: 'take_profit' | 'stop_loss' | 'max_hold' | 'collapsed' } | null {
  const after = obs.filter((o) => o.at > entryAt && o.priceUsd !== null && o.priceUsd > 0).sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const o of after) {
    if (entryLiq !== null && o.liquidityUsd !== null && o.liquidityUsd < entryLiq * COLLAPSE_FRACTION) return { at: o.at, price: 0, liquidityUsd: o.liquidityUsd, reason: 'collapsed' };
    const ch = (o.priceUsd! / entryPrice - 1) * 100;
    if (rules.takeProfitPct !== null && ch >= rules.takeProfitPct) return { at: o.at, price: o.priceUsd!, liquidityUsd: o.liquidityUsd, reason: 'take_profit' };
    if (rules.stopLossPct !== null && ch <= -Math.abs(rules.stopLossPct)) return { at: o.at, price: o.priceUsd!, liquidityUsd: o.liquidityUsd, reason: 'stop_loss' };
    if (rules.maxHoldMinutes !== null && o.at.getTime() - entryAt.getTime() >= rules.maxHoldMinutes * 60_000) return { at: o.at, price: o.priceUsd!, liquidityUsd: o.liquidityUsd, reason: 'max_hold' };
  }
  return null;
}

export interface Stats {
  n: number;
  winRate: number | null;
  meanPct: number | null;
  medianPct: number | null;
  /** Mean return per trade = expectancy, in %. */
  expectancyPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
}

export function stats(returns: number[]): Stats {
  const n = returns.length;
  if (n === 0) return { n, winRate: null, meanPct: null, medianPct: null, expectancyPct: null, bestPct: null, worstPct: null, avgWinPct: null, avgLossPct: null };
  const sorted = [...returns].sort((a, b) => a - b);
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    n,
    winRate: wins.length / n,
    meanPct: mean,
    medianPct: median,
    expectancyPct: mean,
    bestPct: sorted[n - 1],
    worstPct: sorted[0],
    avgWinPct: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null,
    avgLossPct: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
  };
}

/** Largest peak-to-trough fall of an equity curve, as a positive percentage. */
export function maxDrawdownPct(equity: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) worst = Math.max(worst, ((peak - e) / peak) * 100);
  }
  return worst;
}
