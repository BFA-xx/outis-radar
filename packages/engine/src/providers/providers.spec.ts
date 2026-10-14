import { describe, expect, it } from 'vitest';
import { requireChain } from '@outis/shared';
import gtBase from '../__fixtures__/gt-new-pools-base.json';
import gtSolana from '../__fixtures__/gt-new-pools-solana.json';
import dsPairsBase from '../__fixtures__/ds-pairs-base.json';
import dsPumpfun from '../__fixtures__/ds-tokens-solana-pumpfun.json';
import type { FetchLike } from '../http';
import { DexScreenerProvider, normalizeDexScreenerListings, normalizeDexScreenerPairs } from './dexscreener';
import { GeckoTerminalProvider, normalizeGeckoTerminalPools } from './geckoterminal';
import { HealthRecorder } from './types';

const observedAt = new Date('2026-10-11T11:05:00Z');
const noSleep = async () => {};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('GeckoTerminal normalization (real captured payloads)', () => {
  it('normalizes Solana pools, keeping case-sensitive addresses and buyer counts', () => {
    const r = normalizeGeckoTerminalPools(requireChain('solana'), gtSolana, observedAt);
    expect(r.data).toHaveLength(3);
    expect(r.malformed).toBe(1); // the deliberately broken pool
    const first = r.data[0];
    expect(first.chainId).toBe('solana');
    expect(first.pairAddress).toBe('CeADBx5ycyvrRN5PEhPF1VkoHBxMAjQJmVBZmpbQ5rGz');
    expect(first.baseToken.address).toBe('ADrAY3aPJeZh5SNQVBzqkfGo8tgHGuDZKLKzaapDpump');
    expect(first.baseToken.symbol).toBe('Mia');
    expect(first.baseToken.decimals).toBe(6);
    expect(first.dexId).toBe('pump-fun');
    expect(first.pairCreatedAt?.toISOString()).toBe('2026-10-11T10:59:10.000Z');
    expect(first.txns.m5).toEqual({ buys: 14, sells: 16, buyers: 12, sellers: 14 });
    expect(first.liquidityUsd).toBeCloseTo(2439.3096);
    // GT reports market cap as null here: it must stay null, not borrow FDV.
    expect(first.marketCapUsd).toBeNull();
    expect(first.fdvUsd).toBeCloseTo(3076.166325);
    expect(first.estimatedFields).toContain('fdvUsd');
    expect(first.source).toBe('geckoterminal');
    expect(first.url).toContain('/solana/pools/');
  });

  it('lowercases Base addresses', () => {
    const r = normalizeGeckoTerminalPools(requireChain('base'), gtBase, observedAt);
    expect(r.data.length).toBe(3);
    for (const o of r.data) {
      expect(o.pairAddress).toBe(o.pairAddress.toLowerCase());
      expect(o.baseToken.address).toBe(o.baseToken.address.toLowerCase());
    }
  });

  it('reports an unexpected envelope as an error, not an exception', () => {
    const r = normalizeGeckoTerminalPools(requireChain('base'), { nope: true }, observedAt);
    expect(r.data).toEqual([]);
    expect(r.errors[0]).toMatch(/unexpected/);
  });
});

describe('DEX Screener normalization (real captured payloads)', () => {
  it('keeps only requested chains, skips malformed pairs, lowercases EVM', () => {
    const r = normalizeDexScreenerPairs(dsPairsBase, observedAt, 'refresh', [requireChain('base')]);
    expect(r.data).toHaveLength(2); // the robinhood pair is filtered out
    expect(r.malformed).toBe(1);
    const p = r.data[0];
    expect(p.pairAddress).toBe('0xf79478d5a6bae4546f7e489e80b2fc690b558944');
    expect(p.baseToken.address).toBe('0xb2000000000000000000004c27f6523082f41d01');
    expect(p.liquidityUsd).toBeTypeOf('number');
    expect(p.txns.h1.buyers).toBeNull(); // DS never reports distinct wallets
    expect(p.pairCreatedAt).toBeInstanceOf(Date);
  });

  it('leaves liquidity null for a pump.fun bonding-curve pair (DS omits it)', () => {
    const r = normalizeDexScreenerPairs(dsPumpfun, observedAt, 'token_profile', [requireChain('solana')]);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].liquidityUsd).toBeNull();
    expect(r.data[0].pairAddress).toBe('CeADBx5ycyvrRN5PEhPF1VkoHBxMAjQJmVBZmpbQ5rGz');
  });

  it('accepts {pairs: null} as "no results"', () => {
    const r = normalizeDexScreenerPairs({ schemaVersion: '1.0.0', pairs: null }, observedAt, 'refresh', [
      requireChain('base'),
    ]);
    expect(r).toEqual({ data: [], malformed: 0, errors: [] });
  });

  it('filters listings to scanned chains and normalizes addresses', () => {
    const r = normalizeDexScreenerListings(
      [
        { chainId: 'base', tokenAddress: '0xABCDEF0000000000000000000000000000000001' },
        { chainId: 'bsc', tokenAddress: '0x1' },
        { chainId: 'solana' },
      ],
      'token_boost',
      [requireChain('base'), requireChain('solana')],
    );
    expect(r.data).toEqual([
      expect.objectContaining({ tokenAddress: '0xabcdef0000000000000000000000000000000001', reason: 'token_boost' }),
    ]);
    expect(r.malformed).toBe(1);
  });
});

describe('providers over HTTP (mocked)', () => {
  it('GeckoTerminal stops paging on error and records health', async () => {
    const calls: string[] = [];
    const full = { ...gtSolana, data: Array.from({ length: 20 }, (_, i) => ({
      ...(gtSolana.data[0] as object),
      attributes: { ...(gtSolana.data[0] as { attributes: object }).attributes, address: `Pool${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` },
    })) };
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return url.includes('page=1') ? jsonResponse(full) : jsonResponse({ error: 'bad' }, 404);
    };
    const health = new HealthRecorder();
    const gt = new GeckoTerminalProvider({ fetchImpl, sleep: noSleep, health }, 6000);
    const r = await gt.newPools(requireChain('solana'), 3);
    expect(r.data).toHaveLength(20);
    expect(r.errors).toHaveLength(1);
    expect(calls).toHaveLength(2); // 404 is not retried, page 3 never requested
    const h = health.all()[0];
    expect(h).toMatchObject({ provider: 'geckoterminal', scope: 'solana', requests: 2, errors: 1, lastOk: false });
  });

  it('DEX Screener batches 30 addresses per call and dedupes input', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return jsonResponse({ pairs: [] });
    };
    const ds = new DexScreenerProvider({ fetchImpl, sleep: noSleep, health: new HealthRecorder() });
    const ids = Array.from({ length: 65 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    await ds.refreshPairs(requireChain('base'), [...ids, ids[0]]);
    expect(urls).toHaveLength(3);
    expect(urls[0].split('/').pop()!.split(',')).toHaveLength(30);
    expect(urls[2].split('/').pop()!.split(',')).toHaveLength(5);
  });
});
