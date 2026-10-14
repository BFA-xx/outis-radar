/**
 * Alpha score: is this early token worth a trader's attention RIGHT NOW?
 *
 * Momentum alone ranks activity; alpha asks for confluence — several
 * independent signals agreeing (acceleration, real buyers, growing liquidity,
 * a fresh graduation) on a contract that passed its checks. Every point comes
 * with a reason a human can read, and hard blockers veto the score entirely.
 *
 * The thresholds are a starting point, not a proven edge: every "alpha" call
 * is recorded as a signal and its real outcome shows on the Performance page.
 */

export type AlphaTier = 'alpha' | 'watch' | 'none';

export interface AlphaSnapshot {
  minutesAgo: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  txnsH1: number | null;
}

export interface AlphaInputs {
  momentumScore: number | null;
  riskScore: number | null;
  riskCoverage: number | null;
  /** Flagged checks with their severity, e.g. { checkId: 'evm.honeypot', severity: 'critical' }. */
  flagged: Array<{ checkId: string; severity: string; title?: string }>;
  liquidityUsd: number | null;
  ageMinutes: number | null;
  marketAgeMinutes: number | null;
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  volumeM5: number | null;
  volumeH1: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  buyersH1: number | null;
  /** An observation 30–120 min ago, for growth comparisons. */
  earlier: AlphaSnapshot | null;
  liquidityNow: number | null;
  txnsH1: number | null;
  graduatedMinutesAgo: number | null;
  launchpadName: string | null;
}

export interface AlphaResult {
  score: number;
  tier: AlphaTier;
  /** Why it scores: the evidence, strongest first. */
  reasons: string[];
  /** What should make a reader careful, without vetoing. */
  cautions: string[];
  /** Hard vetoes: any one keeps the tier at "none". */
  blockers: string[];
}

export const ALPHA_THRESHOLDS = {
  alpha: 70,
  watch: 55,
  minLiquidityUsd: 10_000,
  maxAgeHours: 24,
  /** Market data older than this is not acted on. */
  maxMarketAgeMinutes: 30,
} as const;

/** Contract findings that make a token untradeable or unfair, whatever its momentum. */
const HARD_BLOCK_CHECKS = new Set(['evm.honeypot', 'evm.creator_history', 'sol.mint_authority', 'sol.freeze_authority', 'liq.removal', 'mkt.one_sided', 'liq.implausible']);

const fmtUsd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

export function scoreAlpha(i: AlphaInputs): AlphaResult {
  const reasons: Array<[number, string]> = [];
  const cautions: string[] = [];
  const blockers: string[] = [];
  let score = 0;
  const add = (pts: number, why: string) => {
    score += pts;
    if (pts > 0) reasons.push([pts, why]);
  };

  // ── Vetoes ─────────────────────────────────────────────────────────────
  for (const f of i.flagged) {
    if (HARD_BLOCK_CHECKS.has(f.checkId) || f.severity === 'critical') blockers.push(f.title ?? f.checkId);
  }
  if (i.liquidityUsd === null || i.liquidityUsd < ALPHA_THRESHOLDS.minLiquidityUsd) blockers.push(`Liquidity under ${fmtUsd(ALPHA_THRESHOLDS.minLiquidityUsd)}`);
  if (i.ageMinutes === null || i.ageMinutes > ALPHA_THRESHOLDS.maxAgeHours * 60) blockers.push('Older than 24h — not early');
  if (i.marketAgeMinutes === null || i.marketAgeMinutes > ALPHA_THRESHOLDS.maxMarketAgeMinutes) blockers.push('Market data is stale');

  // ── Momentum (the existing explainable ranking) ─────────────────────────
  if (i.momentumScore !== null) add(Math.round(i.momentumScore * 0.4), `Momentum ${i.momentumScore.toFixed(0)}/100`);

  // ── Acceleration: the last 5 minutes vs the hour's average pace ─────────
  if (i.volumeM5 !== null && i.volumeH1 !== null && i.volumeH1 > 0) {
    const pace = (i.volumeM5 * 12) / i.volumeH1;
    if (pace >= 2) add(12, `Volume accelerating — last 5 min at ${pace.toFixed(1)}× the hour's pace`);
    else if (pace >= 1.3) add(6, `Volume picking up (${pace.toFixed(1)}× the hour's pace)`);
  }

  // ── Real demand ─────────────────────────────────────────────────────────
  const trades = (i.buysH1 ?? 0) + (i.sellsH1 ?? 0);
  if (trades >= 50 && i.buysH1 !== null) {
    const share = i.buysH1 / trades;
    if (share >= 0.6) add(10, `${Math.round(share * 100)}% of ${trades.toLocaleString('en-US')} trades in 1h are buys`);
    else if (share >= 0.55) add(5, `Buyers ahead: ${Math.round(share * 100)}% buys over ${trades.toLocaleString('en-US')} trades`);
  }
  if (i.buyersH1 !== null) {
    if (i.buyersH1 >= 100) add(8, `${i.buyersH1.toLocaleString('en-US')} distinct buyers in 1h`);
    else if (i.buyersH1 >= 40) add(4, `${i.buyersH1} distinct buyers in 1h`);
  }

  // ── Growth since an earlier observation ─────────────────────────────────
  const e = i.earlier;
  if (e && e.minutesAgo >= 20) {
    if (e.liquidityUsd && i.liquidityNow && e.liquidityUsd > 0) {
      const g = (i.liquidityNow / e.liquidityUsd - 1) * 100;
      if (g >= 30) add(8, `Liquidity +${g.toFixed(0)}% in ${Math.round(e.minutesAgo)} min`);
      else if (g <= -40) cautions.push(`Liquidity ${g.toFixed(0)}% in ${Math.round(e.minutesAgo)} min`);
    }
    if (e.txnsH1 && i.txnsH1 && e.txnsH1 >= 20 && i.txnsH1 / e.txnsH1 >= 1.5) add(6, `Trading activity ${(i.txnsH1 / e.txnsH1).toFixed(1)}× vs ${Math.round(e.minutesAgo)} min ago`);
  }

  // ── Fresh graduation ────────────────────────────────────────────────────
  if (i.graduatedMinutesAgo !== null && i.graduatedMinutesAgo <= 60) {
    add(8, `Graduated from ${i.launchpadName ?? 'its launchpad'} ${Math.max(1, Math.round(i.graduatedMinutesAgo))} min ago`);
  }

  // ── Price action: trending is good, vertical is a warning ───────────────
  if (i.priceChangeH1 !== null) {
    if (i.priceChangeH1 >= 10 && i.priceChangeH1 <= 300) add(6, `Trending +${i.priceChangeH1.toFixed(0)}% in 1h`);
    else if (i.priceChangeH1 > 500) {
      score -= 8;
      cautions.push(`+${i.priceChangeH1.toFixed(0)}% in 1h — vertical moves often reverse`);
    } else if (i.priceChangeH1 <= -30) {
      score -= 10;
      cautions.push(`${i.priceChangeH1.toFixed(0)}% in 1h`);
    }
  }

  // ── Safety ──────────────────────────────────────────────────────────────
  const checked = i.riskScore !== null && i.riskCoverage !== null && i.riskCoverage >= 0.6;
  if (checked && i.riskScore! <= 24) add(8, 'Contract checks clean');
  else if (checked && i.riskScore! <= 44) add(3, 'Contract checks: minor flags only');
  else if (checked) {
    score -= 10;
    cautions.push(`Risk ${i.riskScore}/100`);
  } else cautions.push('Contract checks have not finished — treat as unverified');
  for (const f of i.flagged) {
    if (blockers.includes(f.title ?? f.checkId)) continue;
    if (f.severity === 'high') {
      score -= 6;
      cautions.push(f.title ?? f.checkId);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let tier: AlphaTier = 'none';
  if (blockers.length === 0) {
    if (score >= ALPHA_THRESHOLDS.alpha && checked) tier = 'alpha';
    else if (score >= ALPHA_THRESHOLDS.watch) tier = 'watch';
  }
  return { score, tier, reasons: reasons.sort((a, b) => b[0] - a[0]).map(([, r]) => r), cautions, blockers };
}
