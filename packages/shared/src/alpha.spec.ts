import { describe, expect, it } from 'vitest';
import { type AlphaInputs, scoreAlpha } from './alpha';

const strong: AlphaInputs = {
  momentumScore: 72, riskScore: 12, riskCoverage: 0.8, flagged: [],
  liquidityUsd: 45_000, ageMinutes: 90, marketAgeMinutes: 4,
  priceChangeM5: 6, priceChangeH1: 85, volumeM5: 30_000, volumeH1: 120_000,
  buysH1: 700, sellsH1: 300, buyersH1: 420,
  earlier: { minutesAgo: 45, priceUsd: 0.001, liquidityUsd: 25_000, txnsH1: 300 },
  liquidityNow: 45_000, txnsH1: 1000, graduatedMinutesAgo: 25, launchpadName: 'pump.fun',
};

describe('scoreAlpha', () => {
  it('confluence of signals on a clean contract is an alpha call, with readable reasons', () => {
    const r = scoreAlpha(strong);
    expect(r.tier).toBe('alpha');
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.blockers).toEqual([]);
    expect(r.reasons.join(' ')).toMatch(/accelerating/);
    expect(r.reasons.join(' ')).toMatch(/Graduated from pump.fun 25 min ago/);
    expect(r.reasons.join(' ')).toMatch(/Liquidity \+80% in 45 min/);
  });

  it('a honeypot or live mint authority vetoes everything', () => {
    expect(scoreAlpha({ ...strong, flagged: [{ checkId: 'evm.honeypot', severity: 'critical', title: 'Sell restriction / honeypot' }] })).toMatchObject({ tier: 'none', blockers: ['Sell restriction / honeypot'] });
    expect(scoreAlpha({ ...strong, flagged: [{ checkId: 'sol.mint_authority', severity: 'high', title: 'Mint authority' }] }).tier).toBe('none');
  });

  it('unverified contracts can be watched, never called', () => {
    const r = scoreAlpha({ ...strong, riskScore: 5, riskCoverage: 0.3 });
    expect(r.tier).toBe('watch');
    expect(r.cautions.join(' ')).toMatch(/not finished/);
  });

  it('thin, old or stale tokens are blocked', () => {
    expect(scoreAlpha({ ...strong, liquidityUsd: 4_000 }).tier).toBe('none');
    expect(scoreAlpha({ ...strong, ageMinutes: 3_000 }).tier).toBe('none');
    expect(scoreAlpha({ ...strong, marketAgeMinutes: 90 }).tier).toBe('none');
  });

  it('a vertical candle is a caution and costs points', () => {
    const r = scoreAlpha({ ...strong, priceChangeH1: 900 });
    expect(r.cautions.join(' ')).toMatch(/vertical/);
    expect(r.score).toBeLessThan(scoreAlpha(strong).score);
  });

  it('missing data scores nothing rather than guessing', () => {
    const r = scoreAlpha({ ...strong, momentumScore: null, volumeM5: null, buysH1: null, sellsH1: null, buyersH1: null, earlier: null, graduatedMinutesAgo: null, priceChangeH1: null });
    expect(r.tier).not.toBe('alpha');
  });
});
