import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_PREFS, applyPrefSetting, matchesDiscovery, readPrefs } from './alerts';

const good = { chainId: 'solana', liquidityUsd: 50_000, volumeH24: 40_000, ageMinutes: 30, momentumScore: 70, riskScore: 10, riskCoverage: 0.8 };

describe('matchesDiscovery', () => {
  it('accepts a candidate that clears every bar', () => {
    expect(matchesDiscovery(good, DEFAULT_ALERT_PREFS).ok).toBe(true);
  });

  it('never lets an unknown value pass a threshold', () => {
    for (const k of ['liquidityUsd', 'volumeH24', 'ageMinutes', 'momentumScore', 'riskScore', 'riskCoverage'] as const) {
      expect(matchesDiscovery({ ...good, [k]: null }, DEFAULT_ALERT_PREFS).ok, k).toBe(false);
    }
  });

  it('rejects risky, thin-coverage, stale or off-chain candidates with a reason', () => {
    expect(matchesDiscovery({ ...good, riskScore: 60 }, DEFAULT_ALERT_PREFS).reason).toMatch(/risk/);
    expect(matchesDiscovery({ ...good, riskCoverage: 0.3 }, DEFAULT_ALERT_PREFS).reason).toMatch(/too few/);
    expect(matchesDiscovery({ ...good, ageMinutes: 9999 }, DEFAULT_ALERT_PREFS).ok).toBe(false);
    expect(matchesDiscovery(good, { ...DEFAULT_ALERT_PREFS, chains: ['base'] }).reason).toMatch(/chain/);
  });
});

describe('applyPrefSetting', () => {
  it('parses 50k, $1,000 and plain numbers', () => {
    const a = applyPrefSetting(DEFAULT_ALERT_PREFS, 'minliq', '50k');
    expect(a.ok && a.prefs.discovery.minLiquidityUsd).toBe(50_000);
    const b = applyPrefSetting(DEFAULT_ALERT_PREFS, 'minvol', '$1,000');
    expect(b.ok && b.prefs.discovery.minVolumeH24).toBe(1_000);
    const c = applyPrefSetting(DEFAULT_ALERT_PREFS, 'perhour', '5');
    expect(c.ok && c.prefs.maxPerHour).toBe(5);
  });

  it('rejects unknown keys, non-numbers and out-of-range values without changing anything', () => {
    expect(applyPrefSetting(DEFAULT_ALERT_PREFS, 'nope', '1')).toMatchObject({ ok: false });
    expect(applyPrefSetting(DEFAULT_ALERT_PREFS, 'maxrisk', 'abc')).toMatchObject({ ok: false });
    expect(applyPrefSetting(DEFAULT_ALERT_PREFS, 'maxrisk', '500')).toMatchObject({ ok: false });
    expect(DEFAULT_ALERT_PREFS.discovery.maxRisk).toBe(44);
  });
});

describe('readPrefs', () => {
  it('fills missing fields from defaults and falls back on garbage', () => {
    expect(readPrefs({ discovery: { minMomentum: 80 } }).discovery).toMatchObject({ minMomentum: 80, maxRisk: 44 });
    expect(readPrefs({ chains: ['narnia'] })).toEqual(DEFAULT_ALERT_PREFS);
    expect(readPrefs(null)).toEqual(DEFAULT_ALERT_PREFS);
  });
});
