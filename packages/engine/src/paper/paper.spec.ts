import { describe, expect, it } from 'vitest';
import { DEFAULT_COSTS, type Observation, evaluateSignal, findExit, maxDrawdownPct, netReturn, priceImpact, stats } from './math';
import { matchingRules } from './signals';

const t0 = new Date('2026-10-14T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const o = (min: number, price: number | null, liq: number | null = 50_000): Observation => ({ at: at(min), priceUsd: price, liquidityUsd: liq });

describe('costs', () => {
  it('price impact follows the constant-product approximation', () => {
    expect(priceImpact(100, 10_000)).toBeCloseTo(100 / 5_100); // ~1.96%
    expect(priceImpact(100, 5_000)).toBeCloseTo(100 / 2_600); // ~3.8%
    expect(priceImpact(100, null)).toBeNull();
  });

  it('a flat price loses money after fees, slippage and impact on both sides', () => {
    const r = netReturn(1, 1, 10_000, 10_000, DEFAULT_COSTS);
    expect(r.grossPct).toBe(0);
    expect(r.netPct).toBeLessThan(-6); // 1.5% + ~2% each way
    expect(r.impactKnown).toBe(true);
  });

  it('reports when impact could not be modelled', () => {
    expect(netReturn(1, 2, null, 10_000, DEFAULT_COSTS).impactKnown).toBe(false);
  });
});

describe('evaluateSignal', () => {
  it('never enters at the price that triggered the signal (no look-ahead)', () => {
    const e = evaluateSignal(t0, [o(0, 1), o(0.5, 1.5), o(10, 2), o(75, 3)], at(200));
    expect(e.entry?.priceUsd).toBe(2); // first observation ≥ 1 minute after
    expect(e.entry?.at).toEqual(at(10));
  });

  it('measures each horizon from the entry, net of costs', () => {
    const e = evaluateSignal(t0, [o(10, 1), o(26, 1.2), o(71, 1.5), o(251, 0.9), o(1452, 0.5)], at(2000));
    expect(e.outcomes['15m']).toMatchObject({ status: 'ok', returnPct: expect.closeTo(20, 5) });
    expect(e.outcomes['1h'].returnPct).toBeCloseTo(50);
    expect(e.outcomes['1h'].netReturnPct!).toBeLessThan(50);
    expect(e.outcomes['4h'].returnPct).toBeCloseTo(-10);
    expect(e.outcomes['24h'].returnPct).toBeCloseTo(-50);
    expect(e.mfePct).toBeCloseTo(50);
    expect(e.maePct).toBeCloseTo(-50);
    expect(e.done).toBe(true);
  });

  it('a liquidity collapse is −100% from that point on, not a missing value', () => {
    const e = evaluateSignal(t0, [o(10, 1, 50_000), o(30, 1.1, 40_000), o(50, 0.01, 1_000), o(80, 0.01, 1_000)], at(2000));
    expect(e.collapsedAt).toEqual(at(50));
    expect(e.outcomes['15m'].status).toBe('ok');
    expect(e.outcomes['1h']).toMatchObject({ status: 'collapsed', netReturnPct: -100 });
    expect(e.outcomes['24h'].status).toBe('collapsed');
    expect(e.maePct).toBe(-100);
  });

  it('pending until a horizon passes; no_data when it passed without an observation', () => {
    const early = evaluateSignal(t0, [o(10, 1)], at(30));
    expect(early.outcomes['1h'].status).toBe('pending');
    expect(early.done).toBe(false);
    const late = evaluateSignal(t0, [o(10, 1)], at(3000));
    expect(late.outcomes['1h'].status).toBe('no_data');
    expect(late.done).toBe(true);
  });

  it('a token that never traded again after the signal ends as no_data', () => {
    const e = evaluateSignal(t0, [o(0, 1)], at(2000));
    expect(e.entry).toBeNull();
    expect(e.done).toBe(true);
    expect(e.outcomes['4h'].status).toBe('no_data');
  });
});

describe('findExit', () => {
  const rules = { takeProfitPct: 50, stopLossPct: 20, maxHoldMinutes: 240 };
  it('fills a stop at the OBSERVED price after a gap, not at the stop level', () => {
    const x = findExit(1, at(0), rules, [o(10, 0.95), o(20, 0.4)], 50_000);
    expect(x).toMatchObject({ reason: 'stop_loss', price: 0.4 });
  });
  it('takes profit, times out, and treats a collapse as a total loss', () => {
    expect(findExit(1, at(0), rules, [o(10, 1.6)], 50_000)?.reason).toBe('take_profit');
    expect(findExit(1, at(0), rules, [o(100, 1.1), o(245, 1.05)], 50_000)).toMatchObject({ reason: 'max_hold', price: 1.05 });
    expect(findExit(1, at(0), rules, [o(10, 1.2, 1_000)], 50_000)).toMatchObject({ reason: 'collapsed', price: 0 });
    expect(findExit(1, at(0), { takeProfitPct: null, stopLossPct: null, maxHoldMinutes: null }, [o(10, 9)], 50_000)).toBeNull();
  });
  it('ignores observations from before the entry', () => {
    expect(findExit(1, at(30), rules, [o(10, 5), o(40, 1.01)], 50_000)).toBeNull();
  });
});

describe('stats + drawdown', () => {
  it('computes win rate, expectancy and median', () => {
    const s = stats([10, -5, 20, -15]);
    expect(s).toMatchObject({ n: 4, winRate: 0.5, meanPct: 2.5, expectancyPct: 2.5, medianPct: 2.5, bestPct: 20, worstPct: -15, avgWinPct: 15, avgLossPct: -10 });
    expect(stats([]).winRate).toBeNull();
  });
  it('measures peak-to-trough drawdown', () => {
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBeCloseTo(25);
    expect(maxDrawdownPct([100, 101, 102])).toBe(0);
  });
});

describe('matchingRules', () => {
  const base = { tokenId: 't', pairId: 'p', chainId: 'solana', at: t0, priceUsd: 1, liquidityUsd: 50_000, volumeH24: 40_000, ageMinutes: 30, momentumScore: 70, riskScore: 10, riskCoverage: 0.8 };
  it('strict needs everything; momentum ignores risk; low_risk ignores momentum', () => {
    expect(matchingRules(base).map((r) => r.id)).toEqual(['strict', 'momentum', 'low_risk']);
    expect(matchingRules({ ...base, riskScore: 80 }).map((r) => r.id)).toEqual(['momentum']);
    expect(matchingRules({ ...base, momentumScore: 10 }).map((r) => r.id)).toEqual(['low_risk']);
    expect(matchingRules({ ...base, riskScore: 30 }).map((r) => r.id)).toEqual(['strict', 'momentum']);
  });
});
