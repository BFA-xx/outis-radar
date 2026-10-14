/**
 * Momentum / opportunity ranking. Deliberately separate from risk: it ranks
 * how much a token is happening, not how safe it is. Risk enters only as one
 * visible, weighted factor (riskPenalty), and can be set to weight 0.
 *
 * Each factor maps one observable to 0–1 with a stated rule. The score is a
 * weighted mean over the factors that have data, damped when too few inputs
 * are known, and capped when only one or two signals are strong — a volume
 * spike or one big buy alone must not produce a top score.
 */
import { z } from 'zod';
import { DEFAULT_RISK_CONFIG, type RiskScoringConfig } from './risk';

/**
 * Factors that are evidence of market activity. Only these count toward the
 * "strong signals" needed to escape the single-signal cap — being young, or
 * having a clean risk sheet, is not momentum.
 */
export const ACTIVITY_FACTORS: readonly MomentumFactorKey[] = ['liquidity', 'volumeAcceleration', 'buyPressure', 'participants', 'priceMomentum'];

export const MOMENTUM_FACTORS = [
  'liquidity',
  'volumeAcceleration',
  'buyPressure',
  'participants',
  'age',
  'priceMomentum',
  'holderDistribution',
  'riskPenalty',
] as const;
export type MomentumFactorKey = (typeof MOMENTUM_FACTORS)[number];

export interface MomentumConfig {
  weights: Record<MomentumFactorKey, number>;
  /** If the known factors carry less than this share of total weight, the score is scaled down by that share. */
  minWeightCoverage: number;
  /** A factor counts as "strong" at or above this value. */
  strongAt: number;
  /** With fewer strong factors than this, the score is capped at singleSignalCap. */
  minStrongFactors: number;
  singleSignalCap: number;
  /** Age (minutes) where the age factor is 1; it ramps up before and decays after. */
  idealAgeMinutes: { from: number; to: number };
  maxAgeMinutes: number;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  weights: {
    liquidity: 0.2,
    volumeAcceleration: 0.15,
    buyPressure: 0.1,
    participants: 0.15,
    age: 0.05,
    priceMomentum: 0.1,
    holderDistribution: 0.1,
    riskPenalty: 0.15,
  },
  minWeightCoverage: 0.6,
  strongAt: 0.6,
  minStrongFactors: 3,
  singleSignalCap: 60,
  idealAgeMinutes: { from: 30, to: 360 },
  maxAgeMinutes: 72 * 60,
};

const nonNeg = z.number().finite().min(0);
export const scoringConfigSchema = z.object({
  momentum: z
    .object({
      weights: z.object(Object.fromEntries(MOMENTUM_FACTORS.map((k) => [k, nonNeg.max(10)])) as Record<MomentumFactorKey, z.ZodNumber>),
      minWeightCoverage: z.number().min(0).max(1),
      strongAt: z.number().min(0).max(1),
      minStrongFactors: z.number().int().min(0).max(MOMENTUM_FACTORS.length),
      singleSignalCap: z.number().min(0).max(100),
      idealAgeMinutes: z.object({ from: nonNeg, to: nonNeg }).refine((a) => a.to >= a.from, 'to must be ≥ from'),
      maxAgeMinutes: nonNeg,
    })
    .refine((m) => Object.values(m.weights).some((w) => w > 0), 'At least one weight must be positive'),
  risk: z.object({
    severityPoints: z.object({ info: nonNeg.max(100), low: nonNeg.max(100), medium: nonNeg.max(100), high: nonNeg.max(100), critical: nonNeg.max(100) }),
    confidenceMultiplier: z.object({ low: z.number().min(0).max(1), medium: z.number().min(0).max(1), high: z.number().min(0).max(1) }),
    criticalFloor: z.number().min(0).max(100),
    minCoverage: z.number().min(0).max(1),
    levels: z
      .object({ caution: z.number().min(0).max(100), high: z.number().min(0).max(100), severe: z.number().min(0).max(100) })
      .refine((l) => l.caution <= l.high && l.high <= l.severe, 'Levels must be ascending'),
  }),
});

export interface ScoringConfig {
  momentum: MomentumConfig;
  risk: RiskScoringConfig;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = { momentum: DEFAULT_MOMENTUM_CONFIG, risk: DEFAULT_RISK_CONFIG };

/** Inputs, all nullable — null means unknown and removes the factor rather than scoring it 0. */
export interface MomentumInputs {
  liquidityUsd: number | null;
  /** Set when a risk check found the liquidity figure untrustworthy; the factor then scores 0 with this reason. */
  liquidityDistrust?: string | null;
  /** Trades in the last hour; a price change with no trades behind it is stale. */
  txnsH1?: number | null;
  /** Risk coverage below the minimum — the risk score is then too thin to reward. */
  riskIncomplete?: boolean;
  volumeM5: number | null;
  volumeH1: number | null;
  volumeH6: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  buyersH24: number | null;
  ageMinutes: number | null;
  priceChangeH1: number | null;
  /** Percent of supply held by the top 10 non-pool holders, if a holder check ran. */
  top10HolderPct: number | null;
  /** Current risk score, if assessed. */
  riskScore: number | null;
}

export interface MomentumFactor {
  key: MomentumFactorKey;
  value: number | null;
  weight: number;
  /** Points this factor added to the final score (before caps). */
  contribution: number;
  explanation: string;
}

export interface MomentumResult {
  score: number;
  factors: MomentumFactor[];
  weightCoverage: number;
  adjustments: string[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Map log10(x) linearly from [lo, hi] to [0, 1]. */
const logScale = (x: number, lo: number, hi: number) => clamp01((Math.log10(Math.max(x, 1)) - lo) / (hi - lo));
const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

function factorValue(key: MomentumFactorKey, i: MomentumInputs, cfg: MomentumConfig): { value: number | null; explanation: string } {
  switch (key) {
    case 'liquidity':
      if (i.liquidityDistrust) return { value: 0, explanation: `Liquidity figure not trusted: ${i.liquidityDistrust}` };
      return i.liquidityUsd === null
        ? { value: null, explanation: 'Liquidity not reported.' }
        : { value: logScale(i.liquidityUsd, 3, 6), explanation: `${usd(i.liquidityUsd)} liquidity (log scale: $1K → 0, $1M → 1).` };
    case 'volumeAcceleration': {
      // Compare the latest window with the average of a longer one, using only windows the pair has lived through.
      if (i.ageMinutes !== null && i.ageMinutes >= 360 && i.volumeH1 !== null && i.volumeH6 !== null && i.volumeH6 > 0) {
        const ratio = i.volumeH1 / (i.volumeH6 / 6);
        return { value: clamp01(ratio / 3), explanation: `Last hour's volume is ${ratio.toFixed(1)}× the 6h hourly average (3× → 1).` };
      }
      if (i.ageMinutes !== null && i.ageMinutes >= 60 && i.volumeM5 !== null && i.volumeH1 !== null && i.volumeH1 > 0) {
        const ratio = (i.volumeM5 * 12) / i.volumeH1;
        return { value: clamp01(ratio / 3), explanation: `Last 5 min annualised to the hour is ${ratio.toFixed(1)}× the 1h volume (3× → 1).` };
      }
      return { value: null, explanation: 'Too young, or volume windows not reported — acceleration needs ≥ 1h of history.' };
    }
    case 'buyPressure': {
      if (i.buysH1 === null || i.sellsH1 === null) return { value: null, explanation: 'Buy/sell counts not reported.' };
      const n = i.buysH1 + i.sellsH1;
      if (n < 10) return { value: null, explanation: `Only ${n} trades in the last hour — too few to read.` };
      const share = i.buysH1 / n;
      return { value: clamp01((share - 0.3) / 0.4), explanation: `${Math.round(share * 100)}% of ${n} trades in the last hour were buys (30% → 0, 70% → 1).` };
    }
    case 'participants':
      return i.buyersH24 === null
        ? { value: null, explanation: 'Distinct buyer count not available (only GeckoTerminal reports it).' }
        : { value: logScale(i.buyersH24, 1, 3), explanation: `${i.buyersH24} distinct buyers in 24h (10 → 0, 1,000 → 1).` };
    case 'age': {
      if (i.ageMinutes === null) return { value: null, explanation: 'Pair creation time unknown.' };
      const a = i.ageMinutes;
      const { from, to } = cfg.idealAgeMinutes;
      const v = a < from ? a / Math.max(from, 1) : a <= to ? 1 : clamp01(1 - (a - to) / Math.max(cfg.maxAgeMinutes - to, 1));
      return { value: clamp01(v), explanation: `${Math.round(a)} min old (ideal ${from}–${to} min; fades to 0 at ${cfg.maxAgeMinutes} min).` };
    }
    case 'priceMomentum': {
      if (i.priceChangeH1 === null) return { value: null, explanation: '1h price change not reported.' };
      if (i.txnsH1 === 0) return { value: null, explanation: 'No trades in the last hour — the reported price change is stale.' };
      const c = i.priceChangeH1;
      // Rising is good up to a point; beyond +300% in an hour the move is more likely to reverse.
      const v = c <= -50 ? 0 : c <= 0 ? 0.4 * (1 + c / 50) : c <= 100 ? 0.4 + 0.6 * (c / 100) : c <= 300 ? 1 : clamp01(1 - (c - 300) / 700);
      return { value: clamp01(v), explanation: `${c >= 0 ? '+' : ''}${c.toFixed(1)}% in 1h (−50% → 0, 0 → 0.4, +100–300% → 1, fades after +300%).` };
    }
    case 'holderDistribution':
      return i.top10HolderPct === null
        ? { value: null, explanation: 'Holder distribution not checked yet.' }
        : { value: clamp01(1 - i.top10HolderPct / 80), explanation: `Top 10 holders own ${i.top10HolderPct.toFixed(1)}% (0% → 1, ≥ 80% → 0).` };
    case 'riskPenalty':
      if (i.riskIncomplete) return { value: null, explanation: 'Too few risk checks have run for the risk score to count in either direction.' };
      return i.riskScore === null
        ? { value: null, explanation: 'Not risk-assessed yet.' }
        : { value: clamp01(1 - i.riskScore / 100), explanation: `Risk score ${i.riskScore} (risk 0 → 1, risk 100 → 0).` };
  }
}

export function scoreMomentum(inputs: MomentumInputs, cfg: MomentumConfig = DEFAULT_MOMENTUM_CONFIG): MomentumResult {
  const totalWeight = MOMENTUM_FACTORS.reduce((s, k) => s + cfg.weights[k], 0);
  const raw = MOMENTUM_FACTORS.map((key) => ({ key, weight: cfg.weights[key], ...factorValue(key, inputs, cfg) }));
  const known = raw.filter((f) => f.value !== null && f.weight > 0);
  const knownWeight = known.reduce((s, f) => s + f.weight, 0);
  const adjustments: string[] = [];

  let score = knownWeight === 0 ? 0 : (100 * known.reduce((s, f) => s + f.weight * (f.value as number), 0)) / knownWeight;
  const weightCoverage = totalWeight === 0 ? 0 : knownWeight / totalWeight;

  const factors: MomentumFactor[] = raw.map((f) => ({
    key: f.key,
    value: f.value === null ? null : Math.round(f.value * 100) / 100,
    weight: f.weight,
    contribution: f.value === null || knownWeight === 0 ? 0 : Math.round(((100 * f.weight * f.value) / knownWeight) * 10) / 10,
    explanation: f.explanation,
  }));

  if (weightCoverage < cfg.minWeightCoverage) {
    score *= weightCoverage;
    adjustments.push(`Only ${Math.round(weightCoverage * 100)}% of factor weight has data — score scaled down by that share.`);
  }
  const strong = known.filter((f) => ACTIVITY_FACTORS.includes(f.key) && (f.value as number) >= cfg.strongAt).length;
  if (strong < cfg.minStrongFactors && score > cfg.singleSignalCap) {
    score = cfg.singleSignalCap;
    adjustments.push(`Only ${strong} strong activity signal(s); capped at ${cfg.singleSignalCap} — one spike is not enough evidence.`);
  }
  return { score: Math.round(score * 10) / 10, factors, weightCoverage: Math.round(weightCoverage * 100) / 100, adjustments };
}
