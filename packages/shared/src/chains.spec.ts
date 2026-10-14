import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  chainByProviderId,
  computeChainStatus,
  explorerUrl,
  freshnessOf,
  isPlausibleAddress,
  normalizeAddress,
  requireChain,
  summarizeChain,
} from './index';

describe('chain registry', () => {
  it('has unique ids and unique provider ids per provider', () => {
    const ids = CHAINS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of ['dexscreener', 'geckoterminal'] as const) {
      const pids = CHAINS.map((c) => c.providerIds[provider]).filter(Boolean);
      expect(new Set(pids).size).toBe(pids.length);
    }
  });

  it('never embeds an RPC URL — only env var names', () => {
    for (const c of CHAINS) {
      expect(c.rpcEnvVar).toMatch(/^RPC_URL_[A-Z]+$/);
      expect(JSON.stringify(summarizeChain(c))).not.toMatch(/https?:\/\/[^"]*rpc/i);
    }
  });

  it('declares every capability for every chain', () => {
    for (const c of CHAINS) {
      for (const key of ['discovery', 'marketData', 'metadata', 'holders', 'walletActivity', 'riskChecks'] as const) {
        expect(c.capabilities[key], `${c.id}.${key}`).toBeDefined();
      }
    }
  });

  it('non-EVM chains never carry an EVM chain id; an EVM chain without one says why', () => {
    for (const c of CHAINS) {
      if (c.family !== 'evm') expect(c.evmChainId, c.id).toBeUndefined();
      else if (c.evmChainId === undefined) expect(c.notes?.join(' '), c.id).toMatch(/not yet verified/);
    }
  });

  it('scans every priority-1 chain by default', () => {
    const defaults = CHAINS.filter((c) => c.discoveryEnabledByDefault).map((c) => c.id);
    for (const c of CHAINS.filter((x) => x.priority === 1)) expect(defaults).toContain(c.id);
  });

  it('maps provider chain ids back to our chains', () => {
    expect(chainByProviderId('geckoterminal', 'eth')?.id).toBe('ethereum');
    expect(chainByProviderId('dexscreener', 'ethereum')?.id).toBe('ethereum');
    expect(chainByProviderId('geckoterminal', 'polygon_pos')?.id).toBe('polygon');
    expect(chainByProviderId('dexscreener', 'nope')).toBeUndefined();
  });

  it('lowercases EVM addresses but preserves case-sensitive Solana addresses', () => {
    const base = requireChain('base');
    const sol = requireChain('solana');
    expect(normalizeAddress(base, ' 0xAbC0000000000000000000000000000000000001 ')).toBe(
      '0xabc0000000000000000000000000000000000001',
    );
    expect(normalizeAddress(requireChain('tron'), 'TNpGe4ZcRYEVASiS73gyZ3UiWuwpYgftTh')).toBe('TNpGe4ZcRYEVASiS73gyZ3UiWuwpYgftTh');
    expect(normalizeAddress(sol, 'ADrAY3aPJeZh5SNQVBzqkfGo8tgHGuDZKLKzaapDpump')).toBe(
      'ADrAY3aPJeZh5SNQVBzqkfGo8tgHGuDZKLKzaapDpump',
    );
  });

  it('stores quote assets already normalized', () => {
    for (const c of CHAINS) {
      for (const a of c.quoteAssets ?? []) expect(normalizeAddress(c, a)).toBe(a);
    }
  });

  it('validates address shapes per family', () => {
    expect(isPlausibleAddress(requireChain('base'), '0x4200000000000000000000000000000000000006')).toBe(true);
    expect(isPlausibleAddress(requireChain('base'), 'So11111111111111111111111111111111111111112')).toBe(false);
    expect(isPlausibleAddress(requireChain('solana'), 'So11111111111111111111111111111111111111112')).toBe(true);
    expect(isPlausibleAddress(requireChain('solana'), '0x4200000000000000000000000000000000000006')).toBe(false);
    expect(isPlausibleAddress(requireChain('sui'), '0x2::sui::SUI')).toBe(true);
    expect(isPlausibleAddress(requireChain('tron'), 'TNpGe4ZcRYEVASiS73gyZ3UiWuwpYgftTh')).toBe(true);
  });

  it('builds explorer links', () => {
    expect(explorerUrl(requireChain('solana'), 'token', 'abc')).toBe('https://solscan.io/token/abc');
    expect(explorerUrl(requireChain('base'), 'tx', '0x1')).toBe('https://basescan.org/tx/0x1');
  });
});

describe('computeChainStatus', () => {
  const base = requireChain('base');
  const now = new Date('2026-10-11T12:00:00Z');

  it('is disabled when not scanned, regardless of capabilities', () => {
    expect(computeChainStatus(base, { scanned: false, health: [], now }).status).toBe('disabled');
  });

  it('is unavailable when scanned but no provider has ever answered', () => {
    expect(computeChainStatus(base, { scanned: true, health: [], now }).status).toBe('unavailable');
  });

  it('is unavailable when the last success is stale', () => {
    const health = [
      { provider: 'geckoterminal', chainId: 'base', lastSuccessAt: '2026-10-11T08:00:00Z', lastErrorAt: null, consecutiveFailures: 0 },
    ];
    expect(computeChainStatus(base, { scanned: true, health, now }).status).toBe('unavailable');
  });

  it('is partial when one provider is failing', () => {
    const health = [
      { provider: 'geckoterminal', chainId: 'base', lastSuccessAt: '2026-10-11T11:55:00Z', lastErrorAt: null, consecutiveFailures: 0 },
      { provider: 'dexscreener', chainId: 'base', lastSuccessAt: '2026-10-11T11:00:00Z', lastErrorAt: '2026-10-11T11:55:00Z', consecutiveFailures: 3 },
    ];
    const s = computeChainStatus(base, { scanned: true, health, now });
    expect(s.status).toBe('partial');
    expect(s.reason).toContain('dexscreener');
  });

  it('is live with fresh, healthy providers', () => {
    const health = [
      { provider: 'geckoterminal', chainId: 'base', lastSuccessAt: '2026-10-11T11:55:00Z', lastErrorAt: null, consecutiveFailures: 0 },
    ];
    expect(computeChainStatus(base, { scanned: true, health, now }).status).toBe('live');
  });
});

describe('freshnessOf', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  it('grades by age and treats missing as unavailable', () => {
    expect(freshnessOf(null, now)).toBe('unavailable');
    expect(freshnessOf('2026-10-11T11:55:00Z', now)).toBe('live');
    expect(freshnessOf('2026-10-11T11:30:00Z', now)).toBe('recent');
    expect(freshnessOf('2026-10-11T09:00:00Z', now)).toBe('stale');
  });
});
