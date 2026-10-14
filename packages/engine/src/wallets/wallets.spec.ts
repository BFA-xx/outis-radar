import { describe, expect, it } from 'vitest';
import { requireChain, walletSupport } from '@outis/shared';
import buyFx from '../__fixtures__/solana-pumpfun-buy.json';
import sellFx from '../__fixtures__/solana-pumpfun-sell.json';
import type { FetchLike } from '../http';
import { HealthRecorder } from '../providers/types';
import { EvmRpcProvider } from './evm-rpc';
import { cashFlows, computePositions, type TransferLike, valuePosition } from './positions';
import { SolanaProvider, solanaDeltas } from './solana';
import { NATIVE, addressToTopic, toAmount } from './types';

const t0 = new Date('2026-10-14T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const tr = (txHash: string, min: number, tokenAddress: string, direction: 'in' | 'out', amount: number, symbol: string | null = null): TransferLike => ({ txHash, blockTime: at(min), tokenAddress, direction, amount, symbol });
const TOKEN = 'TokenMint1111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('toAmount', () => {
  it('converts base units exactly for typical decimals', () => {
    expect(toAmount('1500000', 6)).toBe(1.5);
    expect(toAmount('51618840', 9)).toBeCloseTo(0.05161884);
    expect(toAmount('5', 0)).toBe(5);
    expect(toAmount('1', 18)).toBe(1e-18);
  });
});

describe('solanaDeltas (real pump.fun transactions)', () => {
  it('a buy: +tokens and −SOL in the same transaction', () => {
    const rows = solanaDeltas(buyFx.tx as never, buyFx.wallet, buyFx.signature);
    const token = rows.find((r) => r.tokenAddress !== NATIVE)!;
    const sol = rows.find((r) => r.tokenAddress === NATIVE)!;
    expect(token).toMatchObject({ direction: 'in', amountRaw: '405470384363', logIndex: 0 });
    expect(sol).toMatchObject({ direction: 'out', amountRaw: '51618840', decimals: 9 });
  });

  it('a sell: −tokens and +SOL', () => {
    const rows = solanaDeltas(sellFx.tx as never, sellFx.wallet, sellFx.signature);
    expect(rows.find((r) => r.tokenAddress !== NATIVE)).toMatchObject({ direction: 'out', amountRaw: '101741679063' });
    expect(rows.find((r) => r.tokenAddress === NATIVE)).toMatchObject({ direction: 'in', amountRaw: '12168271' });
  });

  it('ignores failed transactions and wallets that are not involved', () => {
    expect(solanaDeltas({ ...(buyFx.tx as object), meta: { ...(buyFx.tx as { meta: object }).meta, err: { x: 1 } } } as never, buyFx.wallet, 's')).toEqual([]);
    expect(solanaDeltas(buyFx.tx as never, 'NotInThisTx1111111111111111111111111111111', 's')).toEqual([]);
  });

  it('feeds positions: the real buy prices the tokens in SOL', () => {
    const rows = solanaDeltas(buyFx.tx as never, buyFx.wallet, buyFx.signature).map((r) => ({ ...r, amount: toAmount(r.amountRaw, r.decimals) }));
    const [p] = computePositions('solana', rows);
    expect(p.unit).toBe('native');
    expect(p.events[0].side).toBe('buy');
    expect(p.events[0].quote).toBeCloseTo(0.05161884);
    expect(p.complete).toBe(true);
  });
});

describe('computePositions', () => {
  it('average cost, partial sell, realized PnL in the paid unit', () => {
    const [p] = computePositions('solana', [
      tr('b1', 0, TOKEN, 'in', 1000), tr('b1', 0, NATIVE, 'out', 1),
      tr('b2', 5, TOKEN, 'in', 1000), tr('b2', 5, NATIVE, 'out', 3),
      tr('s1', 10, TOKEN, 'out', 1000), tr('s1', 10, NATIVE, 'in', 4),
    ]);
    expect(p.unit).toBe('native');
    expect(p.avgEntry).toBeCloseTo(0.002); // 4 SOL / 2000 tokens
    expect(p.realized).toBeCloseTo(2); // sold half (cost 2) for 4
    expect(p.netQty).toBe(1000);
    expect(p.openCost).toBeCloseTo(2);
    expect(p.complete).toBe(true);
    expect(valuePosition(p, 0.005)).toEqual({ value: 5, unrealized: 3 });
  });

  it('a transfer in has unknown cost: avg entry, open cost and unrealized become unknown', () => {
    const [p] = computePositions('solana', [tr('b1', 0, TOKEN, 'in', 100), tr('b1', 0, NATIVE, 'out', 1), tr('x', 1, TOKEN, 'in', 50)]);
    expect(p.avgEntry).toBeNull();
    expect(p.openCost).toBeNull();
    expect(p.complete).toBe(false);
    expect(p.issues[0]).toMatch(/without a payment leg/);
    expect(valuePosition(p, 0.02).unrealized).toBeNull();
  });

  it('does not split one payment across several tokens', () => {
    const ps = computePositions('solana', [tr('m', 0, TOKEN, 'in', 10), tr('m', 0, 'Other111111111111111111111111111111111111111', 'in', 10), tr('m', 0, NATIVE, 'out', 1)]);
    expect(ps.every((p) => !p.complete && p.issues[0].match(/Several tokens/))).toBe(true);
  });

  it('does not mix units: bought with SOL, sold for USDC', () => {
    const [p] = computePositions('solana', [tr('b', 0, TOKEN, 'in', 10), tr('b', 0, NATIVE, 'out', 1), tr('s', 1, TOKEN, 'out', 10), tr('s', 1, USDC, 'in', 300)]);
    expect(p.complete).toBe(false);
    expect(p.realized).toBeNull();
  });

  it('flags a sale larger than tracked buys (position predates tracking)', () => {
    const [p] = computePositions('solana', [tr('s', 0, TOKEN, 'out', 10), tr('s', 0, NATIVE, 'in', 1)]);
    expect(p.realized).toBeNull();
    expect(p.issues.join(' ')).toMatch(/predates tracking/);
  });

  it('a fresh buy after a full exit starts a new, known cost basis', () => {
    const [p] = computePositions('solana', [
      tr('x', 0, TOKEN, 'in', 10),
      tr('s', 1, TOKEN, 'out', 10), tr('s', 1, NATIVE, 'in', 1),
      tr('b', 2, TOKEN, 'in', 20), tr('b', 2, NATIVE, 'out', 2),
    ]);
    expect(p.netQty).toBe(20);
    expect(p.openCost).toBeCloseTo(2);
    expect(p.realized).toBeNull(); // the earlier round trip's cost is still unknown
  });

  it('treats wrapped native as native and stablecoins as USD', () => {
    const [p] = computePositions('base', [tr('b', 0, '0xtok', 'in', 10), tr('b', 0, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'out', 50)]);
    expect(p).toMatchObject({ unit: 'usd', avgEntry: 5 });
  });
});

describe('cashFlows', () => {
  it('sums money in and out per asset, with canonical symbols, and ignores tokens', () => {
    const f = cashFlows('arbitrum', 'ETH', [
      tr('a', 0, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'in', 100),
      tr('b', 1, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'out', 30),
      tr('c', 2, NATIVE, 'out', 0.5),
      tr('d', 3, '0xsometoken', 'in', 999),
    ]);
    expect(f).toEqual([
      { tokenAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', unit: 'usd', received: 100, sent: 30, transfers: 2 },
      { tokenAddress: NATIVE, symbol: 'ETH', unit: 'native', received: 0, sent: 0.5, transfers: 1 },
    ]);
  });
});

describe('walletSupport', () => {
  it('uses the user RPC first, then verified public sources, else asks for config', () => {
    expect(walletSupport(requireChain('base'), {}).state).toBe('needs_config');
    expect(walletSupport(requireChain('base'), { RPC_URL_BASE: 'https://example.invalid/key' }).source).toMatchObject({ kind: 'rpc', userConfigured: true });
    expect(walletSupport(requireChain('arbitrum'), {}).source?.kind).toBe('public_rpc');
    expect(walletSupport(requireChain('ethereum'), {}).source?.kind).toBe('blockscout');
    expect(walletSupport(requireChain('solana'), {}).source?.kind).toBe('solana_rpc');
    expect(walletSupport(requireChain('robinhood'), {}).note).toMatch(/RPC_URL_ROBINHOOD/);
    expect(walletSupport(requireChain('tron'), {}).state).toBe('unavailable');
  });
});

// ── Providers over mocked HTTP ───────────────────────────────────────────

const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });
const noSleep = async () => {};
const budget = { deadline: Date.now() + 60_000, backfillHours: 24, maxTxFetches: 10 };

describe('EvmRpcProvider (mocked RPC)', () => {
  const W = '0x1111111111111111111111111111111111111111';
  const TOKEN_A = '0x2222222222222222222222222222222222222222';
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  function rpcMock(opts: { maxSpan: number; logTs?: string }) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const single = (req: { id: number; method: string; params: unknown[] }) => {
      calls.push(req);
      const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: req.id, result });
      switch (req.method) {
        case 'eth_blockNumber':
          return reply('0x3e8'); // 1000
        case 'eth_getLogs': {
          const p = req.params[0] as { fromBlock: string; toBlock: string; topics: Array<string | null> };
          if (Number(p.toBlock) - Number(p.fromBlock) + 1 > opts.maxSpan) return ok({ jsonrpc: '2.0', id: req.id, error: { code: -32005, message: 'query exceeds max block range' } });
          const incoming = p.topics[2] !== null && p.topics[2] !== undefined;
          if (!incoming || Number(p.fromBlock) > 990 || Number(p.toBlock) < 990) return reply([]);
          return reply([
            { address: TOKEN_A, topics: [TRANSFER, addressToTopic('0x3333333333333333333333333333333333333333'), addressToTopic(W)], data: '0x0de0b6b3a7640000', blockNumber: '0x3de', blockTimestamp: opts.logTs ?? '0x6720f000', transactionHash: '0xaa', logIndex: '0x5' },
            // ERC-721 (4 topics) — must be skipped
            { address: TOKEN_A, topics: [TRANSFER, addressToTopic('0x3333333333333333333333333333333333333333'), addressToTopic(W), '0x01'], data: '0x', blockNumber: '0x3de', transactionHash: '0xbb', logIndex: '0x6' },
          ]);
        }
        case 'eth_getTransactionByHash':
          return reply({ from: W, value: '0x2386f26fc10000', blockNumber: '0x3de' }); // 0.01 ETH
        case 'eth_getBlockByNumber':
          return reply({ timestamp: '0x6720f000' });
        default:
          return reply('0x');
      }
    };
    const fetchImpl: FetchLike = async (_u, init) => {
      const parsed = JSON.parse(init!.body!);
      if (Array.isArray(parsed)) {
        // JSON-RPC batch: answer every call, in order.
        const answers = await Promise.all(parsed.map(async (r) => (await single(r).json()) as object));
        return ok(answers);
      }
      return single(parsed);
    };
    return { fetchImpl, calls };
  }

  it('halves the range when the node refuses it, skips NFTs, and recovers the ETH paid', async () => {
    const { fetchImpl, calls } = rpcMock({ maxSpan: 100 });
    const res = await new EvmRpcProvider().sync(
      requireChain('arbitrum'),
      W,
      { kind: 'rpc', url: 'https://rpc.test/a', userConfigured: true, logTimestamps: true },
      { lastBlock: 800 },
      budget,
      { fetchImpl, sleep: noSleep, health: new HealthRecorder(), knownDecimals: () => 18 },
    );
    expect(res.complete).toBe(true);
    expect(res.cursor).toMatchObject({ lastBlock: 1000 });
    expect(Number(res.cursor.span)).toBeLessThanOrEqual(100);
    const token = res.transfers.filter((t) => t.tokenAddress !== NATIVE);
    expect(token).toHaveLength(1);
    expect(token[0]).toMatchObject({ direction: 'in', amountRaw: '1000000000000000000', decimals: 18, tokenAddress: TOKEN_A });
    expect(res.transfers.find((t) => t.tokenAddress === NATIVE)).toMatchObject({ direction: 'out', amountRaw: '10000000000000000' });
    expect(calls.some((c) => c.method === 'eth_getBlockByNumber')).toBe(false); // logs carried timestamps
  });

  it('treats blockTimestamp 0x0 as missing and resolves it from batched block headers (Arbitrum public RPC quirk)', async () => {
    const { fetchImpl, calls } = rpcMock({ maxSpan: 10_000, logTs: '0x0' });
    const res = await new EvmRpcProvider().sync(
      requireChain('arbitrum'),
      W,
      { kind: 'public_rpc', url: 'https://rpc.test/b', userConfigured: false, logTimestamps: true },
      { lastBlock: 900 },
      budget,
      { fetchImpl, sleep: noSleep, health: new HealthRecorder(), knownDecimals: () => 18 },
    );
    const token = res.transfers.find((t) => t.tokenAddress !== NATIVE)!;
    expect(token.blockTime.getTime()).toBe(0x6720f000 * 1000);
    expect(calls.some((c) => c.method === 'eth_getBlockByNumber')).toBe(true);
  });

  it('knows money-token decimals (USDC = 6) and keeps unscaled rows out of totals', () => {
    const f = cashFlows('arbitrum', 'ETH', [
      { ...tr('a', 0, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'in', 13.3), decimals: 6 },
      { ...tr('b', 0, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'in', 13301412), decimals: null },
    ]);
    expect(f[0].received).toBe(13.3);
  });
});

describe('SolanaProvider (mocked RPC)', () => {
  // sig5 is newest. The mock honours `before`/`until` like the real RPC.
  const all = Array.from({ length: 5 }, (_, i) => ({ signature: `sig${5 - i}`, blockTime: Math.floor(Date.now() / 1000) - i * 60, slot: 100 - i, err: null }));
  function mock() {
    const fetched: string[] = [];
    const fetchImpl: FetchLike = async (_u, init) => {
      const req = JSON.parse(init!.body!) as { id: number; method: string; params: [string, { before?: string; until?: string }] };
      if (req.method === 'getSignaturesForAddress') {
        const { before, until } = req.params[1];
        let list = all;
        if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1);
        if (until) list = list.slice(0, Math.max(0, list.findIndex((s) => s.signature === until)));
        return ok({ jsonrpc: '2.0', id: req.id, result: list });
      }
      fetched.push(req.params[0] as unknown as string);
      return ok({ jsonrpc: '2.0', id: req.id, result: buyFx.tx });
    };
    return { fetchImpl, fetched };
  }
  const run = (cursor: Record<string, unknown> | null, max: number, fetchImpl: FetchLike) =>
    new SolanaProvider().sync(requireChain('solana'), buyFx.wallet, { kind: 'solana_rpc', url: 'https://sol.test', userConfigured: true }, cursor, { ...budget, maxTxFetches: max }, { fetchImpl, sleep: noSleep, health: new HealthRecorder(), knownDecimals: () => null });

  it('loads newest first and keeps the rest as an explicit range', async () => {
    const m = mock();
    const res = await run(null, 3, m.fetchImpl);
    expect(m.fetched).toEqual(['sig5', 'sig4', 'sig3']);
    expect(res.cursor).toEqual({ head: 'sig5', ranges: [{ before: 'sig3' }] });
    expect(res.complete).toBe(false);
  });

  it('fills the remaining range next run, then reports complete', async () => {
    const m = mock();
    const res = await run({ head: 'sig5', ranges: [{ before: 'sig3' }] }, 10, m.fetchImpl);
    expect(m.fetched).toEqual(['sig2', 'sig1']);
    expect(res.cursor).toEqual({ head: 'sig5', ranges: [] });
    expect(res.complete).toBe(true);
  });

  it('takes new activity first and never moves the head past unfetched work', async () => {
    const m = mock();
    // head at sig3: sig5 and sig4 are new; budget 1 → sig5 fetched, sig4 kept as a range.
    const res = await run({ head: 'sig3', ranges: [] }, 1, m.fetchImpl);
    expect(m.fetched).toEqual(['sig5']);
    expect(res.cursor).toEqual({ head: 'sig5', ranges: [{ before: 'sig5', until: 'sig3' }] });
  });
});
