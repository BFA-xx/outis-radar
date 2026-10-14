/**
 * Solana wallet history from JSON-RPC.
 *
 * getSignaturesForAddress lists transactions touching the wallet (newest
 * first); getTransaction (jsonParsed) gives exact pre/post balances. For each
 * transaction we record the wallet's NET change per mint (token balances whose
 * owner is the wallet) plus its native SOL change (pre/post lamports, which
 * includes the fee when the wallet paid it — a real cost of the trade).
 *
 * Per-transaction net deltas make swaps exact: a pump.fun buy shows −SOL and
 * +TOKEN in the same transaction, which is the cost basis. Temporary wSOL
 * accounts opened and closed inside one transaction never appear in pre/post
 * balances, so their SOL shows up in the native delta, where it belongs.
 */
import type { ChainSpec, WalletSource } from '@outis/shared';
import { RateLimiter, fetchJson } from '../http';
import { type RawTransfer, type SyncBudget, type SyncContext, type SyncResult, type WalletProvider, NATIVE } from './types';

interface SigInfo {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
}

interface TokenBal {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface ParsedTx {
  blockTime: number | null;
  slot: number;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: string } | string> } };
}

const limiters = new Map<string, RateLimiter>();

/** Net per-mint and native deltas for one wallet in one transaction. Pure; unit-tested. */
export function solanaDeltas(tx: ParsedTx, wallet: string, signature: string): RawTransfer[] {
  if (!tx.meta || tx.meta.err) return [];
  const time = new Date((tx.blockTime ?? 0) * 1000);
  const out: RawTransfer[] = [];
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));

  const byMint = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  const add = (list: TokenBal[] | undefined, side: 'pre' | 'post') => {
    for (const b of list ?? []) {
      if (b.owner !== wallet) continue;
      const e = byMint.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
      e[side] += BigInt(b.uiTokenAmount.amount);
      byMint.set(b.mint, e);
    }
  };
  add(tx.meta.preTokenBalances, 'pre');
  add(tx.meta.postTokenBalances, 'post');
  for (const [mint, e] of byMint) {
    const d = e.post - e.pre;
    if (d === 0n) continue;
    out.push({ txHash: signature, logIndex: 0, blockNumber: tx.slot, blockTime: time, tokenAddress: mint, symbol: null, direction: d > 0n ? 'in' : 'out', amountRaw: (d > 0n ? d : -d).toString(), decimals: e.decimals, counterparty: null });
  }

  const idx = keys.indexOf(wallet);
  if (idx >= 0) {
    const d = BigInt(tx.meta.postBalances[idx] ?? 0) - BigInt(tx.meta.preBalances[idx] ?? 0);
    if (d !== 0n) out.push({ txHash: signature, logIndex: 0, blockNumber: tx.slot, blockTime: time, tokenAddress: NATIVE, symbol: 'SOL', direction: d > 0n ? 'in' : 'out', amountRaw: (d > 0n ? d : -d).toString(), decimals: 9, counterparty: null });
  }
  return out;
}

export class SolanaProvider implements WalletProvider {
  async sync(chain: ChainSpec, address: string, source: WalletSource, cursor: Record<string, unknown> | null, budget: SyncBudget, ctx: SyncContext): Promise<SyncResult> {
    let limiter = limiters.get(source.url);
    // The public endpoint allows bursts but throttles hard; own RPCs are faster.
    if (!limiter) limiters.set(source.url, (limiter = new RateLimiter(source.userConfigured ? 600 : 90, Date.now, ctx.sleep)));
    let id = 0;
    const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
      const body = (await fetchJson(source.url, {
        limiter: limiter!,
        fetchImpl: ctx.fetchImpl,
        sleep: ctx.sleep,
        signal: ctx.signal,
        retries: 3,
        timeoutMs: 20_000,
        body: { jsonrpc: '2.0', id: ++id, method, params },
        onRequest: (r) => ctx.health.record('solana_rpc', chain.id, r),
      })) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`Solana RPC: ${String(body.error.message).slice(0, 160)}`);
      return body.result as T;
    };

    /**
     * Newest first. Cursor = { head, ranges }:
     *  head    newest signature already covered — anything newer is new activity;
     *  ranges  stretches still to fetch, each "older than `before`, newer than
     *          `until`" (no `until` = back to the backfill horizon).
     * Each run takes new activity first, then works through the ranges. When
     * the budget runs out mid-range, the remainder is kept as a range, so no
     * transaction is ever skipped silently — and recent trades show up first.
     */
    type Range = { before?: string; until?: string };
    const head = typeof cursor?.head === 'string' ? cursor.head : undefined;
    const pendingRanges: Range[] = Array.isArray(cursor?.ranges) ? (cursor.ranges as Range[]) : [];
    const horizon = Date.now() / 1000 - budget.backfillHours * 3600;
    const notes: string[] = [];
    const transfers: RawTransfer[] = [];
    if (!head && pendingRanges.length === 0) notes.push(`First sync: newest activity first, back to ~${budget.backfillHours}h.`);

    const work: Range[] = [{ until: head }, ...pendingRanges];
    const leftover: Range[] = [];
    let newHead = head;
    let fetched = 0;
    const outOfBudget = () => fetched >= budget.maxTxFetches || Date.now() >= budget.deadline || Boolean(ctx.signal?.aborted);

    for (let w = 0; w < work.length; w++) {
      const range = work[w];
      if (outOfBudget()) {
        leftover.push(range);
        continue;
      }
      let before = range.before;
      let firstPage = true;
      pages: while (true) {
        const page = await rpc<SigInfo[]>('getSignaturesForAddress', [address, { limit: 1000, ...(range.until ? { until: range.until } : {}), ...(before ? { before } : {}) }]);
        // The newest signature of the new-activity range becomes the head.
        if (w === 0 && firstPage && page[0]) newHead = page[0].signature;
        firstPage = false;
        for (const sig of page) {
          if (!range.until && sig.blockTime !== null && sig.blockTime < horizon) break pages; // reached the backfill horizon
          if (!sig.err) {
            if (outOfBudget()) {
              // Everything older than the last processed signature is still to do.
              leftover.push({ before, until: range.until });
              break pages;
            }
            const tx = await rpc<ParsedTx | null>('getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
            fetched++;
            if (tx) transfers.push(...solanaDeltas(tx, address, sig.signature));
          }
          before = sig.signature;
        }
        if (page.length < 1000) break; // no older signatures in this range
      }
    }

    const complete = leftover.length === 0;
    if (!complete) notes.push(`Recent activity loaded first; ${leftover.length} older stretch(es) still loading over the next runs.`);
    return { transfers, cursor: { head: newHead, ranges: leftover }, complete, notes };
  }
}
