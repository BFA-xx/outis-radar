import { describe, expect, it } from 'vitest';
import { requireChain } from '@outis/shared';
import paper from '../__fixtures__/goplus-base-paper.json';
import pepe from '../__fixtures__/goplus-eth-pepe.json';
import angel from '../__fixtures__/goplus-solana-angel.json';
import type { FetchLike } from '../http';
import { HealthRecorder } from '../providers/types';
import { GoPlusProvider, evmChecksFromGoPlus, solanaChecksFromGoPlus } from './goplus';
import { type MarketCheckInput, marketChecks } from './market-checks';

const at = new Date('2026-10-11T12:00:00Z');
const byId = (rs: ReturnType<typeof evmChecksFromGoPlus>) => Object.fromEntries(rs.map((r) => [r.checkId, r]));

describe('GoPlus EVM interpretation (real captured records)', () => {
  it('PAPER (Base): clean contract, but 100% of LP held unlocked by the deployer', () => {
    const rec = paper.result['0x598da152e4648d52cfea1bfc3c671f026772da54'];
    const r = byId(evmChecksFromGoPlus(rec, [], at));
    expect(r['evm.honeypot'].status).toBe('passed');
    expect(r['evm.tax'].status).toBe('passed');
    expect(r['evm.mint'].status).toBe('passed');
    expect(r['evm.ownership'].status).toBe('passed'); // owner is the zero address
    expect(r['liq.lp_control']).toMatchObject({ status: 'flagged', severity: 'high' });
    expect(r['liq.lp_control'].explanation).toMatch(/100%/);
    // GoPlus had no holder list yet for this new token: not checked, not passed.
    expect(r['holders.concentration'].status).toBe('not_checked');
  });

  it('PEPE (Ethereum): concentration measured over EOAs, excluding the locked burn address', () => {
    const rec = pepe.result['0x6982508145454ce325ddbe47a25d4ec3d2311933'];
    const r = byId(evmChecksFromGoPlus(rec, [], at));
    const conc = r['holders.concentration'];
    expect(['flagged', 'passed']).toContain(conc.status);
    expect(conc.evidence?.top10Pct).toBeGreaterThan(30);
    expect(conc.evidence?.top10Pct).toBeLessThan(45);
    // LP sits in pool contracts, which are not "a wallet that can pull it".
    expect(r['liq.lp_control'].status).toBe('passed');
  });

  it('flags a honeypot as critical/high-confidence and a high sell tax', () => {
    const r = byId(evmChecksFromGoPlus({ is_honeypot: '1', cannot_sell_all: '1', buy_tax: '0', sell_tax: '0.35', slippage_modifiable: '1' }, [], at));
    expect(r['evm.honeypot']).toMatchObject({ status: 'flagged', severity: 'critical', confidence: 'high' });
    expect(r['evm.tax']).toMatchObject({ status: 'flagged', severity: 'high' });
    expect(r['evm.tax'].explanation).toMatch(/Sell tax 35\.0%/);
  });

  it('treats omitted fields as not checked, never as passed', () => {
    const r = byId(evmChecksFromGoPlus({}, [], at));
    for (const id of ['evm.honeypot', 'evm.tax', 'evm.mint', 'evm.trading_controls', 'evm.upgradeable', 'evm.source', 'holders.creator', 'liq.lp_control']) {
      expect(r[id].status, id).toBe('not_checked');
    }
  });

  it('excludes our own pair addresses from holder concentration', () => {
    const rec = {
      holders: [
        { address: '0xpool', percent: '0.9', is_contract: 0, is_locked: 0 },
        { address: '0xwhale', percent: '0.05', is_contract: 0, is_locked: 0 },
      ],
    };
    const r = byId(evmChecksFromGoPlus(rec, ['0xPOOL'], at));
    expect(r['holders.concentration'].evidence?.top10Pct).toBe(5);
    expect(r['holders.concentration'].status).toBe('passed');
  });
});

describe('GoPlus Solana interpretation', () => {
  it('ANGEL (pump.fun): authorities revoked, no Token-2022 traps', () => {
    const rec = angel.result['4j1exMn96PuWtUGu1uVYoSnNZz4VdZ9STstMYuPRpump'];
    const r = byId(solanaChecksFromGoPlus(rec, at));
    expect(r['sol.mint_authority'].status).toBe('passed');
    expect(r['sol.freeze_authority'].status).toBe('passed');
    expect(r['sol.token2022'].status).toBe('passed');
    expect(r['sol.metadata_mutable'].status).toBe('passed');
  });

  it('flags live authorities and a permanent delegate', () => {
    const r = byId(
      solanaChecksFromGoPlus(
        {
          mintable: { status: '1', authority: [{ address: 'Auth1' }] },
          freezable: { status: '1', authority: [] },
          balance_mutable_authority: { status: '1', authority: [] },
          non_transferable: '0',
          metadata_mutable: { status: '1' },
        },
        at,
      ),
    );
    expect(r['sol.mint_authority']).toMatchObject({ status: 'flagged', severity: 'high' });
    expect(r['sol.mint_authority'].explanation).toContain('Auth1');
    expect(r['sol.freeze_authority'].status).toBe('flagged');
    expect(r['sol.token2022']).toMatchObject({ status: 'flagged', severity: 'critical' });
    expect(r['sol.metadata_mutable']).toMatchObject({ status: 'flagged', severity: 'low' });
  });
});

describe('GoPlusProvider over HTTP (mocked)', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });
  const noSleep = async () => {};

  it('reads code 4029 (sent as HTTP 200) as a rate limit and retries', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => (n++ === 0 ? ok({ code: 4029, message: 'too many requests' }) : ok(paper));
    const health = new HealthRecorder();
    const gp = new GoPlusProvider({ fetchImpl, sleep: noSleep, health }, 6000);
    const r = await gp.tokenSecurity(requireChain('base'), '0x598da152e4648d52cfea1bfc3c671f026772da54');
    expect(r.kind).toBe('ok');
    expect(n).toBe(2);
    expect(health.all()[0].rateLimited).toBe(1);
  });

  it('accepts a partial (code 3) result: present fields count, absent ones stay unchecked', async () => {
    const partial = { code: 3, message: 'OK', result: { '0xabc0000000000000000000000000000000000001': { is_open_source: '1', buy_tax: '', sell_tax: '', holder_count: '60' } } };
    const gp = new GoPlusProvider({ fetchImpl: async () => ok(partial), sleep: noSleep, health: new HealthRecorder() }, 6000);
    const r = await gp.tokenSecurity(requireChain('base'), '0xabc0000000000000000000000000000000000001');
    expect(r.kind).toBe('ok');
    const checks = byId(evmChecksFromGoPlus((r as { record: Record<string, unknown> }).record, [], at));
    expect(checks['evm.source'].status).toBe('passed');
    expect(checks['evm.tax'].status).toBe('not_checked'); // empty-string taxes are unknown, not 0%
    expect(checks['evm.honeypot'].status).toBe('not_checked');
  });

  it('reports an empty record as not indexed (fresh token), not as clean', async () => {
    const gp = new GoPlusProvider({ fetchImpl: async () => ok({ code: 1, message: 'OK', result: {} }), sleep: noSleep, health: new HealthRecorder() }, 6000);
    expect((await gp.tokenSecurity(requireChain('tron'), 'TNpGe4ZcRYEVASiS73gyZ3UiWuwpYgftTh')).kind).toBe('not_indexed');
  });

  it('refuses chains GoPlus does not cover without calling it', async () => {
    let called = false;
    const gp = new GoPlusProvider({ fetchImpl: async () => ((called = true), ok({})), sleep: noSleep, health: new HealthRecorder() }, 6000);
    expect((await gp.tokenSecurity(requireChain('hyperevm'), '0x1')).kind).toBe('unsupported');
    expect(called).toBe(false);
  });
});

describe('market checks', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const base: MarketCheckInput = {
    liquidityUsd: 80_000,
    volumeH24: 40_000,
    priceUsd: 0.01,
    priceChangeH1: 5,
    priceChangeH6: 20,
    pairCreatedAt: new Date('2026-10-11T06:00:00Z'),
    marketUpdatedAt: new Date('2026-10-11T11:58:00Z'),
    txns: { h24: { buys: 300, sells: 250, buyers: 120, sellers: 90 }, h1: { buys: 20, sells: 15, buyers: null, sellers: null } },
    liquidityHistory: [
      { at: new Date('2026-10-11T10:00:00Z'), liquidityUsd: 82_000 },
      { at: new Date('2026-10-11T11:58:00Z'), liquidityUsd: 80_000 },
    ],
  };
  const run = (over: Partial<MarketCheckInput>) => Object.fromEntries(marketChecks({ ...base, ...over }, now).map((r) => [r.checkId, r]));

  it('a healthy pair passes every market check', () => {
    for (const r of marketChecks(base, now)) expect(r.status, r.checkId).toBe('passed');
  });

  it('grades thin liquidity and leaves unknown liquidity unchecked', () => {
    expect(run({ liquidityUsd: 3_000 })['liq.depth']).toMatchObject({ status: 'flagged', severity: 'high' });
    expect(run({ liquidityUsd: 15_000 })['liq.depth']).toMatchObject({ status: 'flagged', severity: 'medium' });
    expect(run({ liquidityUsd: null })['liq.depth'].status).toBe('not_checked');
  });

  it('detects a liquidity pull from snapshots', () => {
    const r = run({ liquidityHistory: [{ at: new Date('2026-10-11T10:00:00Z'), liquidityUsd: 100_000 }, { at: new Date('2026-10-11T11:00:00Z'), liquidityUsd: 120_000 }, { at: new Date('2026-10-11T11:58:00Z'), liquidityUsd: 20_000 }] })['liq.removal'];
    expect(r).toMatchObject({ status: 'flagged', severity: 'critical' });
    expect(r.evidence?.peakUsd).toBe(120_000);
    expect(run({ liquidityHistory: [] })['liq.removal'].status).toBe('not_checked');
  });

  it('flags phantom liquidity (the v4 case seen live: $328K liquidity, $95/day volume)', () => {
    expect(run({ liquidityUsd: 328_000, volumeH24: 95 })['liq.phantom']).toMatchObject({ status: 'flagged', severity: 'medium' });
  });

  it('flags many buys with zero sells', () => {
    expect(run({ txns: { h24: { buys: 40, sells: 0, buyers: 30, sellers: 0 } } })['mkt.one_sided']).toMatchObject({ status: 'flagged', severity: 'high' });
  });

  it('flags trades concentrated in few wallets, and needs trader counts to judge', () => {
    expect(run({ txns: { h24: { buys: 500, sells: 500, buyers: 10, sellers: 10 } } })['mkt.wash']).toMatchObject({ status: 'flagged', severity: 'high' });
    expect(run({ txns: { h24: { buys: 500, sells: 500, buyers: null, sellers: null } } })['mkt.wash'].status).toBe('not_checked');
  });

  it('flags stale and incomplete data', () => {
    expect(run({ marketUpdatedAt: new Date('2026-10-11T09:00:00Z') })['data.stale']).toMatchObject({ status: 'flagged', severity: 'low' });
    expect(run({ liquidityUsd: null, pairCreatedAt: null })['data.incomplete']).toMatchObject({ status: 'flagged', severity: 'medium' });
  });
});

describe('liq.implausible (QTC case seen live: $1.07B liquidity, 30 min old, $25K volume)', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const input: MarketCheckInput = {
    liquidityUsd: 1.07e9,
    fdvUsd: null,
    volumeH24: 24_700,
    priceUsd: 102,
    priceChangeH1: 0,
    priceChangeH6: 0,
    pairCreatedAt: new Date('2026-10-11T11:30:00Z'),
    marketUpdatedAt: now,
    txns: null,
    liquidityHistory: [],
  };
  const get = (over: Partial<MarketCheckInput>) => marketChecks({ ...input, ...over }, now).find((r) => r.checkId === 'liq.implausible')!;

  it('flags enormous liquidity on a new, barely-traded pair', () => {
    expect(get({})).toMatchObject({ status: 'flagged', severity: 'high' });
  });
  it('flags liquidity far above FDV', () => {
    expect(get({ liquidityUsd: 500_000, fdvUsd: 50_000, pairCreatedAt: new Date('2026-10-01T00:00:00Z') }).status).toBe('flagged');
  });
  it('passes a normal pool', () => {
    expect(get({ liquidityUsd: 80_000, fdvUsd: 400_000, volumeH24: 50_000 }).status).toBe('passed');
  });
});
