import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  type CheckResult,
  DEFAULT_MOMENTUM_CONFIG,
  DEFAULT_SCORING_CONFIG,
  type MomentumInputs,
  checksFor,
  goplusChainId,
  requireChain,
  scoreMomentum,
  scoreRisk,
  scoringConfigSchema,
} from './index';

const at = new Date('2026-10-11T12:00:00Z');
function r(checkId: string, status: CheckResult['status'], severity: CheckResult['severity'] = 'info', confidence: CheckResult['confidence'] = 'high'): CheckResult {
  const spec = CHECKS.find((c) => c.id === checkId)!;
  return { checkId, category: spec.category, status, severity, confidence, title: spec.title, explanation: '', evidence: null, source: 'test', observedAt: at };
}

describe('check catalog', () => {
  it('has unique ids and every check applies somewhere', () => {
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
    for (const c of CHECKS) expect(c.families.length).toBeGreaterThan(0);
  });

  it('never applies EVM contract checks to Solana, or Solana checks to EVM', () => {
    expect(checksFor('solana').some((c) => c.id.startsWith('evm.'))).toBe(false);
    expect(checksFor('evm').some((c) => c.id.startsWith('sol.'))).toBe(false);
    expect(checksFor('tron').some((c) => c.id.startsWith('evm.'))).toBe(true);
  });

  it('maps chains to GoPlus ids only where GoPlus lists them', () => {
    expect(goplusChainId(requireChain('base'))).toBe('8453');
    expect(goplusChainId(requireChain('solana'))).toBe('solana');
    expect(goplusChainId(requireChain('tron'))).toBe('tron');
    expect(goplusChainId(requireChain('robinhood'))).toBe('4663');
    expect(goplusChainId(requireChain('hyperevm'))).toBeNull();
    expect(goplusChainId(requireChain('sui'))).toBeNull();
  });
});

describe('scoreRisk', () => {
  it('scores 0 with "no major flags" when every check passed, at full coverage', () => {
    const s = scoreRisk([r('evm.honeypot', 'passed'), r('evm.tax', 'passed'), r('liq.depth', 'passed')]);
    expect(s).toMatchObject({ score: 0, level: 'no_major_flags', coverage: 1, incomplete: false });
  });

  it('does NOT treat not-checked as passed: coverage drops and the result is incomplete', () => {
    const s = scoreRisk([r('evm.honeypot', 'not_checked'), r('evm.tax', 'not_checked'), r('liq.depth', 'passed')]);
    expect(s.score).toBe(0);
    expect(s.coverage).toBeCloseTo(0.33, 2);
    expect(s.incomplete).toBe(true);
    expect(s.checksRun).toBe(1);
  });

  it('ignores not_applicable entirely', () => {
    expect(scoreRisk([r('liq.depth', 'passed'), r('evm.tax', 'not_applicable')]).coverage).toBe(1);
  });

  it('combines flags without exceeding 100 and weights by confidence', () => {
    const one = scoreRisk([r('evm.tax', 'flagged', 'high', 'high')]);
    expect(one.score).toBe(35);
    const lowConf = scoreRisk([r('evm.tax', 'flagged', 'high', 'low')]);
    expect(lowConf.score).toBe(18); // 35 × 0.5, rounded
    const many = scoreRisk(['evm.tax', 'evm.mint', 'evm.ownership', 'evm.source', 'evm.trading_controls'].map((id) => r(id, 'flagged', 'high')));
    expect(many.score).toBeGreaterThan(80);
    expect(many.score).toBeLessThanOrEqual(100);
  });

  it('floors the score when a critical flag is high-confidence', () => {
    const s = scoreRisk([r('evm.honeypot', 'flagged', 'critical', 'high'), r('liq.depth', 'passed')]);
    expect(s.score).toBe(DEFAULT_SCORING_CONFIG.risk.criticalFloor);
    expect(s.level).toBe('severe');
  });

  it('reports per-category scores and counts', () => {
    const s = scoreRisk([r('liq.depth', 'flagged', 'medium'), r('liq.removal', 'not_checked'), r('evm.tax', 'passed')]);
    expect(s.categories.liquidity).toEqual({ score: 15, flagged: 1, run: 1, applicable: 2 });
    expect(s.categories.contract).toEqual({ score: 0, flagged: 0, run: 1, applicable: 1 });
  });
});

const base: MomentumInputs = {
  liquidityUsd: 100_000,
  volumeM5: 2_000,
  volumeH1: 20_000,
  volumeH6: 60_000,
  buysH1: 70,
  sellsH1: 30,
  buyersH24: 300,
  ageMinutes: 400,
  priceChangeH1: 40,
  top10HolderPct: 20,
  riskScore: 10,
};

describe('scoreMomentum', () => {
  it('explains every factor and the contributions add up to the score', () => {
    const m = scoreMomentum(base);
    expect(m.factors).toHaveLength(8);
    for (const f of m.factors) expect(f.explanation.length).toBeGreaterThan(5);
    const sum = m.factors.reduce((s, f) => s + f.contribution, 0);
    expect(Math.abs(sum - m.score)).toBeLessThan(0.5);
    expect(m.adjustments).toEqual([]);
  });

  it('drops unknown factors instead of scoring them as zero', () => {
    const m = scoreMomentum({ ...base, buyersH24: null });
    const f = m.factors.find((x) => x.key === 'participants')!;
    expect(f.value).toBeNull();
    expect(f.contribution).toBe(0);
    expect(m.weightCoverage).toBeLessThan(1);
  });

  it('scales the score down when most inputs are unknown', () => {
    const sparse = scoreMomentum({ liquidityUsd: 1_000_000, volumeM5: null, volumeH1: null, volumeH6: null, buysH1: null, sellsH1: null, buyersH24: null, ageMinutes: null, priceChangeH1: null, top10HolderPct: null, riskScore: null });
    expect(sparse.weightCoverage).toBeCloseTo(0.2);
    expect(sparse.score).toBeLessThanOrEqual(20);
    expect(sparse.adjustments[0]).toMatch(/scaled down/);
  });

  it('caps a token whose only strength is one spike', () => {
    const spike = scoreMomentum({ ...base, liquidityUsd: 2_000, volumeM5: 50_000, volumeH1: 60_000, buysH1: 5, sellsH1: 3, buyersH24: 12, priceChangeH1: -20, top10HolderPct: 70, riskScore: 60, ageMinutes: 400 });
    expect(spike.score).toBeLessThanOrEqual(DEFAULT_MOMENTUM_CONFIG.singleSignalCap);
  });

  it('reads extreme pumps as weaker, not stronger', () => {
    const v = (c: number) => scoreMomentum({ ...base, priceChangeH1: c }).factors.find((f) => f.key === 'priceMomentum')!.value!;
    expect(v(200)).toBe(1);
    expect(v(900)).toBeLessThan(v(200));
    expect(v(-60)).toBe(0);
  });

  it('only measures acceleration over windows the pair has lived through', () => {
    const young = scoreMomentum({ ...base, ageMinutes: 30 }).factors.find((f) => f.key === 'volumeAcceleration')!;
    expect(young.value).toBeNull();
  });

  it('respects weights — setting riskPenalty to 0 removes risk from the ranking', () => {
    const cfg = { ...DEFAULT_MOMENTUM_CONFIG, weights: { ...DEFAULT_MOMENTUM_CONFIG.weights, riskPenalty: 0 } };
    const a = scoreMomentum({ ...base, riskScore: 0 }, cfg);
    const b = scoreMomentum({ ...base, riskScore: 100 }, cfg);
    expect(a.score).toBe(b.score);
  });
});

describe('scoringConfigSchema', () => {
  it('accepts the defaults', () => {
    expect(scoringConfigSchema.safeParse(DEFAULT_SCORING_CONFIG).success).toBe(true);
  });
  it('rejects negative weights, all-zero weights and descending levels', () => {
    const neg = structuredClone(DEFAULT_SCORING_CONFIG);
    neg.momentum.weights.liquidity = -1;
    expect(scoringConfigSchema.safeParse(neg).success).toBe(false);
    const zero = structuredClone(DEFAULT_SCORING_CONFIG);
    for (const k of Object.keys(zero.momentum.weights) as Array<keyof typeof zero.momentum.weights>) zero.momentum.weights[k] = 0;
    expect(scoringConfigSchema.safeParse(zero).success).toBe(false);
    const levels = structuredClone(DEFAULT_SCORING_CONFIG);
    levels.risk.levels = { caution: 50, high: 40, severe: 70 };
    expect(scoringConfigSchema.safeParse(levels).success).toBe(false);
  });
});

describe('momentum guards found on live data (2026-10-11)', () => {
  it('scores distrusted liquidity as 0 with the reason, not as $1B of strength', () => {
    const f = scoreMomentum({ ...base, liquidityUsd: 1.07e9, liquidityDistrust: 'Implausible liquidity flagged.' }).factors.find((x) => x.key === 'liquidity')!;
    expect(f.value).toBe(0);
    expect(f.explanation).toMatch(/not trusted/);
  });

  it('ignores a price change with no trades behind it', () => {
    const f = scoreMomentum({ ...base, priceChangeH1: 262, txnsH1: 0 }).factors.find((x) => x.key === 'priceMomentum')!;
    expect(f.value).toBeNull();
  });

  it('does not reward a low risk score that rests on too few checks', () => {
    const f = scoreMomentum({ ...base, riskScore: 4, riskIncomplete: true }).factors.find((x) => x.key === 'riskPenalty')!;
    expect(f.value).toBeNull();
  });

  it('counts only activity factors as strong signals — youth and a clean sheet are not momentum', () => {
    const m = scoreMomentum({ ...base, liquidityUsd: 2_000, volumeM5: null, volumeH1: null, volumeH6: null, buysH1: null, sellsH1: null, buyersH24: 300, priceChangeH1: null, top10HolderPct: 0, riskScore: 0, ageMinutes: 60 });
    expect(m.score).toBeLessThanOrEqual(DEFAULT_MOMENTUM_CONFIG.singleSignalCap);
  });
});
