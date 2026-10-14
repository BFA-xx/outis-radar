/**
 * EVM wallet history from JSON-RPC Transfer logs.
 *
 * Two eth_getLogs per block range: Transfer(from = wallet) and Transfer(to =
 * wallet). Only 3-topic logs are ERC-20 transfers; ERC-721 Transfer carries a
 * 4th (tokenId) topic and is skipped.
 *
 * Ranges adapt: a provider that rejects a range as too large gets half of it,
 * down to a floor. Native-coin (ETH) movements are not logs: the one we can
 * reconstruct cheaply is ETH sent WITH a buy (tx.value from the wallet),
 * fetched per buy transaction within budget. ETH received from a sell arrives
 * as an internal transfer, which needs tracing — not available here, so sell
 * proceeds paid in ETH stay unknown (and PnL says so).
 */
import { type ChainSpec, type WalletSource } from '@outis/shared';
import { RateLimiter, fetchJson, redactUrl } from '../http';
import { QUOTE_TOKENS, quoteUnitOf } from './positions';
import { type RawTransfer, type SyncBudget, type SyncContext, type SyncResult, type WalletProvider, NATIVE, addressToTopic, topicToAddress } from './types';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DECIMALS_SELECTOR = '0x313ce567';
const SYMBOL_SELECTOR = '0x95d89b41';

interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

const limiters = new Map<string, RateLimiter>();
function limiterFor(url: string, userConfigured: boolean, sleep?: SyncContext['sleep']): RateLimiter {
  const key = redactUrl(url);
  let l = limiters.get(key);
  if (!l) {
    // Public endpoints are shared with the world; be gentle. Own keys can go faster.
    l = new RateLimiter(userConfigured ? 300 : 60, Date.now, sleep);
    limiters.set(key, l);
  }
  return l;
}

export class RpcError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

/** Messages providers use when a log range is too wide. */
const RANGE_TOO_LARGE = /range|too many|limit|exceed|10000|block range|response size|query returned more/i;

function decodeAbiString(hex: string): string | null {
  try {
    const h = hex.replace(/^0x/, '');
    if (h.length === 64) {
      // bytes32 symbol (old tokens like MKR)
      return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '') || null;
    }
    const len = parseInt(h.slice(64, 128), 16);
    return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8') || null;
  } catch {
    return null;
  }
}

export class EvmRpcProvider implements WalletProvider {
  async sync(chain: ChainSpec, address: string, source: WalletSource, cursor: Record<string, unknown> | null, budget: SyncBudget, ctx: SyncContext): Promise<SyncResult> {
    const limiter = limiterFor(source.url, source.userConfigured, ctx.sleep);
    const healthKey = source.userConfigured ? 'rpc' : 'public_rpc';
    let id = 0;
    const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
      const body = (await fetchJson(source.url, {
        limiter,
        fetchImpl: ctx.fetchImpl,
        sleep: ctx.sleep,
        signal: ctx.signal,
        retries: 2,
        timeoutMs: 20_000,
        body: { jsonrpc: '2.0', id: ++id, method, params },
        onRequest: (r) => ctx.health.record(healthKey, chain.id, r),
      })) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new RpcError(String(body.error.message).slice(0, 200), body.error.code);
      return body.result as T;
    };

    /** JSON-RPC batch: one HTTP request, many calls. Results come back in request order. */
    const rpcBatch = async <T>(calls: Array<{ method: string; params: unknown[] }>): Promise<Array<T | null>> => {
      const reqs = calls.map((c) => ({ jsonrpc: '2.0', id: ++id, method: c.method, params: c.params }));
      const body = (await fetchJson(source.url, {
        limiter,
        fetchImpl: ctx.fetchImpl,
        sleep: ctx.sleep,
        signal: ctx.signal,
        retries: 2,
        timeoutMs: 30_000,
        body: reqs,
        onRequest: (r) => ctx.health.record(healthKey, chain.id, r),
      })) as Array<{ id: number; result?: T; error?: unknown }> | { error?: { message: string } };
      if (!Array.isArray(body)) throw new RpcError(`batch not supported: ${String(body?.error?.message ?? '').slice(0, 120)}`, null);
      const byId = new Map(body.map((r) => [r.id, r.result ?? null]));
      return reqs.map((r) => (byId.get(r.id) as T | undefined) ?? null);
    };

    const wallet = address.toLowerCase();
    const notes: string[] = [];
    const latest = Number(BigInt(await rpc<string>('eth_blockNumber', [])));

    // Block time from two headers, used to turn "backfill hours" into blocks.
    const blockTimeCache = new Map<number, number>();
    const blockTime = async (n: number): Promise<number> => {
      const cached = blockTimeCache.get(n);
      if (cached !== undefined) return cached;
      const b = await rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
      if (!b) throw new RpcError(`block ${n} not found`, null);
      const t = Number(BigInt(b.timestamp));
      blockTimeCache.set(n, t);
      return t;
    };

    let from: number;
    const lastBlock = typeof cursor?.lastBlock === 'number' ? cursor.lastBlock : null;
    if (lastBlock !== null) from = lastBlock + 1;
    else {
      const probe = Math.max(0, latest - 10_000);
      const [tLatest, tProbe] = await Promise.all([blockTime(latest), blockTime(probe)]);
      const secPerBlock = Math.max((tLatest - tProbe) / Math.max(latest - probe, 1), 0.01);
      from = Math.max(0, latest - Math.ceil((budget.backfillHours * 3600) / secPerBlock));
      notes.push(`First sync: history from ~${budget.backfillHours}h back (block ${from}). Earlier activity is not loaded.`);
    }

    let span = typeof cursor?.span === 'number' ? cursor.span : source.userConfigured ? 2_000 : 5_000;
    const logs: Log[] = [];
    let done = from > latest;
    let processedTo = from - 1;
    const walletTopic = addressToTopic(wallet);

    // Leave time after the log scan for timestamps, decimals and native legs.
    const scanDeadline = budget.deadline - 20_000;
    while (!done && Date.now() < scanDeadline && !ctx.signal?.aborted) {
      const to = Math.min(from + span - 1, latest);
      const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
      try {
        const [outs, ins] = await Promise.all([
          rpc<Log[]>('eth_getLogs', [{ ...range, topics: [TRANSFER, walletTopic] }]),
          rpc<Log[]>('eth_getLogs', [{ ...range, topics: [TRANSFER, null, walletTopic] }]),
        ]);
        logs.push(...outs, ...ins);
        processedTo = to;
        from = to + 1;
        done = from > latest;
      } catch (err) {
        if (err instanceof RpcError && RANGE_TOO_LARGE.test(err.message) && span > 50) {
          span = Math.max(50, Math.floor(span / 2));
          continue;
        }
        throw err;
      }
    }
    if (!done) notes.push(`Stopped at block ${processedTo} of ${latest}; continues next run.`);

    // ERC-20 only, not reorged away.
    const erc20 = logs.filter((l) => l.topics.length === 3 && !l.removed);
    const tokens = [...new Set(erc20.map((l) => l.address.toLowerCase()))];

    // Decimals: money tokens are known; then our DB; then eth_call (batched).
    const meta = new Map<string, { decimals: number | null; symbol: string | null }>();
    const unknown: string[] = [];
    for (const t of tokens) {
      const q = QUOTE_TOKENS[chain.id]?.[t];
      const d = q?.decimals ?? ctx.knownDecimals(t);
      if (d !== null && d !== undefined) meta.set(t, { decimals: d, symbol: q?.symbol ?? null });
      else unknown.push(t);
    }
    for (let i = 0; i < unknown.length && Date.now() < budget.deadline; i += 25) {
      const part = unknown.slice(i, i + 25);
      try {
        const res = await rpcBatch<string>(part.flatMap((t) => [
          { method: 'eth_call', params: [{ to: t, data: DECIMALS_SELECTOR }, 'latest'] },
          { method: 'eth_call', params: [{ to: t, data: SYMBOL_SELECTOR }, 'latest'] },
        ]));
        part.forEach((t, k) => {
          const d = res[2 * k];
          const sym = res[2 * k + 1];
          const dec = d && d !== '0x' ? Number(BigInt(d)) : null;
          meta.set(t, { decimals: dec !== null && dec <= 36 ? dec : null, symbol: sym && sym !== '0x' ? decodeAbiString(sym) : null });
        });
      } catch {
        // Leave unknown: those transfers are stored with decimals = null and kept out of PnL.
      }
    }

    // Timestamps. Some nodes put blockTimestamp in logs but send 0x0 (seen on
    // Arbitrum's public RPC, 2026-10-14) — anything implausible counts as missing.
    const MIN_TS = Date.UTC(2015, 0, 1) / 1000;
    const tsOf = new Map<number, number>();
    for (const l of erc20) {
      const t = l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : 0;
      if (t > MIN_TS) tsOf.set(Number(BigInt(l.blockNumber)), t);
    }
    const missingBlocks = [...new Set(erc20.map((l) => Number(BigInt(l.blockNumber))))].filter((n) => !tsOf.has(n)).sort((a, b) => a - b);
    for (let i = 0; i < missingBlocks.length; i += 50) {
      if (Date.now() >= budget.deadline) break;
      const part = missingBlocks.slice(i, i + 50);
      try {
        const res = await rpcBatch<{ timestamp: string }>(part.map((n) => ({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] })));
        part.forEach((n, k) => {
          const t = res[k] ? Number(BigInt(res[k]!.timestamp)) : 0;
          if (t > MIN_TS) tsOf.set(n, t);
        });
      } catch {
        // Fall back to one header at a time for this chunk.
        for (const n of part) {
          if (Date.now() >= budget.deadline) break;
          try {
            const t = await blockTime(n);
            if (t > MIN_TS) tsOf.set(n, t);
          } catch {
            /* unresolved — handled below */
          }
        }
      }
    }
    // Never store a transfer without a real time: rewind the cursor to just before the first unresolved block.
    const unresolved = missingBlocks.filter((n) => !tsOf.has(n));
    if (unresolved.length > 0) {
      processedTo = Math.min(processedTo, unresolved[0] - 1);
      done = false;
      notes.push(`Timestamps for ${unresolved.length} block(s) not resolved in time; those transfers load next run.`);
    }

    const transfers: RawTransfer[] = [];
    for (const l of erc20) {
      const n = Number(BigInt(l.blockNumber));
      if (n > processedTo) continue;
      const ts = tsOf.get(n);
      if (ts === undefined) continue;
      const fromAddr = topicToAddress(l.topics[1]);
      const toAddr = topicToAddress(l.topics[2]);
      if (fromAddr === wallet && toAddr === wallet) continue; // self-transfer
      const token = l.address.toLowerCase();
      const m = meta.get(token);
      transfers.push({
        txHash: l.transactionHash.toLowerCase(),
        logIndex: Number(BigInt(l.logIndex)),
        blockNumber: n,
        blockTime: new Date(ts * 1000),
        tokenAddress: token,
        symbol: m?.symbol ?? null,
        direction: toAddr === wallet ? 'in' : 'out',
        amountRaw: BigInt(l.data === '0x' ? '0x0' : l.data).toString(),
        decimals: m?.decimals ?? null,
        counterparty: toAddr === wallet ? fromAddr : toAddr,
      });
    }

    // Native leg of buys: ETH the wallet itself sent along with the transaction.
    // Only receipts of non-money tokens are buys; USDC/WETH arriving is not.
    const buyTxs = [...new Set(transfers.filter((t) => t.direction === 'in' && !quoteUnitOf(chain.id, t.tokenAddress)).map((t) => t.txHash))];
    let fetched = 0;
    for (const hash of buyTxs) {
      if (fetched >= budget.maxTxFetches || Date.now() >= budget.deadline) {
        notes.push(`Native-coin legs not fetched for ${buyTxs.length - fetched} buy transaction(s); their cost stays unknown.`);
        break;
      }
      fetched++;
      try {
        const tx = await rpc<{ from: string; value: string; blockNumber: string } | null>('eth_getTransactionByHash', [hash]);
        if (tx && tx.from.toLowerCase() === wallet && BigInt(tx.value) > 0n) {
          const sample = transfers.find((t) => t.txHash === hash)!;
          transfers.push({
            txHash: hash,
            logIndex: -1,
            blockNumber: sample.blockNumber,
            blockTime: sample.blockTime,
            tokenAddress: NATIVE,
            symbol: chain.nativeAsset.symbol,
            direction: 'out',
            amountRaw: BigInt(tx.value).toString(),
            decimals: chain.nativeAsset.decimals,
            counterparty: null,
          });
        }
      } catch {
        // Unknown native leg → unknown cost, reported by the PnL engine.
      }
    }

    return { transfers, cursor: { lastBlock: processedTo, span }, complete: done, notes };
  }
}
