import { describe, expect, it } from 'vitest';
import { type PairObservation, emptyTxns, emptyWindows, requireChain } from '@outis/shared';
import { mergeObservations, sumKnown } from './merge';
import { CARRY_MAX_MS, combineFields, isInverted, minuteBucket } from './persist';

function obs(over: Partial<PairObservation>): PairObservation {
  return {
    chainId: 'base',
    pairAddress: '0xpair',
    dexId: null,
    baseToken: { address: '0xbase', symbol: null, name: null, decimals: null, imageUrl: null },
    quoteToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: null, decimals: null, imageUrl: null },
    pairCreatedAt: null,
    priceUsd: null,
    priceNative: null,
    liquidityUsd: null,
    fdvUsd: null,
    marketCapUsd: null,
    volumeUsd: emptyWindows(null),
    txns: emptyTxns(),
    priceChangePct: emptyWindows(null),
    url: null,
    source: 'geckoterminal',
    reason: 'new_pool',
    observedAt: new Date('2026-10-11T11:00:00Z'),
    estimatedFields: [],
    ...over,
  };
}

describe('mergeObservations', () => {
  it('deduplicates by (chain, pair) and keeps every observation', () => {
    const merged = mergeObservations([
      obs({ source: 'geckoterminal' }),
      obs({ source: 'dexscreener', reason: 'token_boost' }),
      obs({ pairAddress: '0xother' }),
      obs({ chainId: 'solana', pairAddress: '0xpair' }), // same address, different chain
    ]);
    expect(merged).toHaveLength(3);
    const m = merged.find((x) => x.chainId === 'base' && x.pairAddress === '0xpair')!;
    expect(m.observations).toHaveLength(2);
    expect(m.reasons.sort()).toEqual(['new_pool', 'token_boost']);
  });

  it('takes each field from the highest-priority source that reported it, and attributes it', () => {
    const gt = obs({ source: 'geckoterminal', liquidityUsd: null, priceUsd: 1.5 });
    gt.txns.h1 = { buys: 3, sells: 1, buyers: 2, sellers: 1 };
    const ds = obs({ source: 'dexscreener', liquidityUsd: 9000, priceUsd: 1.6 });
    ds.txns.h1 = { buys: 4, sells: 2, buyers: null, sellers: null };
    const [m] = mergeObservations([ds, gt]);
    expect(m.priceUsd).toBe(1.5);
    expect(m.fieldSources.priceUsd).toBe('geckoterminal');
    // GT had no liquidity: DS fills it rather than null winning.
    expect(m.liquidityUsd).toBe(9000);
    expect(m.fieldSources.liquidityUsd).toBe('dexscreener');
    expect(m.txns.h1).toEqual({ buys: 3, sells: 1, buyers: 2, sellers: 1 });
  });

  it('respects a custom priority order', () => {
    const [m] = mergeObservations(
      [obs({ source: 'geckoterminal', priceUsd: 1 }), obs({ source: 'dexscreener', priceUsd: 2 })],
      ['dexscreener', 'geckoterminal'],
    );
    expect(m.priceUsd).toBe(2);
  });

  it('uses the earliest reported creation time', () => {
    const [m] = mergeObservations([
      obs({ source: 'geckoterminal', pairCreatedAt: new Date('2026-10-11T10:00:00Z') }),
      obs({ source: 'dexscreener', pairCreatedAt: new Date('2026-10-11T09:59:00Z') }),
    ]);
    expect(m.pairCreatedAt?.toISOString()).toBe('2026-10-11T09:59:00.000Z');
    expect(m.pairCreatedAtSource).toBe('dexscreener');
  });

  it('marks a field estimated only if its winning source said so', () => {
    const [m] = mergeObservations([
      obs({ source: 'geckoterminal', fdvUsd: 100, estimatedFields: ['fdvUsd'] }),
      obs({ source: 'dexscreener', liquidityUsd: 5 }),
    ]);
    expect(m.estimatedFields).toEqual(['fdvUsd']);
  });
});

describe('sumKnown', () => {
  it('is null unless every part is known', () => {
    expect(sumKnown(1, 2)).toBe(3);
    expect(sumKnown(1, null)).toBeNull();
    expect(sumKnown(0, 0)).toBe(0);
  });
});

describe('combineFields (carry-over across refreshes)', () => {
  const now = new Date('2026-10-11T12:00:00Z');

  it('takes new values and stamps them', () => {
    const r = combineFields({ priceUsd: 2 }, { priceUsd: 'dexscreener' }, now, { priceUsd: 1 }, null, now);
    expect(r.values.priceUsd).toBe(2);
    expect(r.stamps.priceUsd).toEqual({ source: 'dexscreener', at: now.toISOString() });
  });

  it('carries a missing field forward with its ORIGINAL timestamp', () => {
    const at = new Date(now.getTime() - 60 * 60_000).toISOString();
    const r = combineFields(
      { 'txns.h1.buyers': null },
      {},
      now,
      { 'txns.h1.buyers': 7 },
      { 'txns.h1.buyers': { source: 'geckoterminal', at } },
      now,
    );
    expect(r.values['txns.h1.buyers']).toBe(7);
    expect(r.stamps['txns.h1.buyers']).toEqual({ source: 'geckoterminal', at });
  });

  it('drops a carried value once it is too old to present as current', () => {
    const at = new Date(now.getTime() - CARRY_MAX_MS - 1).toISOString();
    const r = combineFields(
      { liquidityUsd: null },
      {},
      now,
      { liquidityUsd: 5000 },
      { liquidityUsd: { source: 'geckoterminal', at } },
      now,
    );
    expect(r.values.liquidityUsd).toBeNull();
    expect(r.stamps.liquidityUsd).toBeUndefined();
  });
});

describe('isInverted', () => {
  const base = requireChain('base');
  it('flags WETH-as-base pairs so WETH is never listed as a new token', () => {
    const [m] = mergeObservations([
      obs({
        baseToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: null, decimals: null, imageUrl: null },
        quoteToken: { address: '0xnew', symbol: 'NEW', name: null, decimals: null, imageUrl: null },
      }),
    ]);
    expect(isInverted(base, m)).toBe(true);
  });
  it('does not flag WETH/USDC (both quote assets) or a normal pair', () => {
    const [weth_usdc] = mergeObservations([
      obs({
        baseToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: null, decimals: null, imageUrl: null },
        quoteToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', name: null, decimals: null, imageUrl: null },
      }),
    ]);
    expect(isInverted(base, weth_usdc)).toBe(false);
    expect(isInverted(base, mergeObservations([obs({})])[0])).toBe(false);
  });
});

describe('minuteBucket', () => {
  it('floors to the minute so re-runs within a minute collide on the unique key', () => {
    expect(minuteBucket(new Date('2026-10-11T12:34:56.789Z')).toISOString()).toBe('2026-10-11T12:34:00.000Z');
  });
});
