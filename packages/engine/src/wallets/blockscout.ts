/**
 * EVM wallet history from a keyless Blockscout API (/api/v2).
 *
 * Token transfers come newest-first with cursor pagination. On the first sync
 * we page back to the backfill horizon; afterwards only down to the last block
 * we stored. If a page budget runs out first, the gap is reported.
 */
import { type ChainSpec, type WalletSource } from '@outis/shared';
import { RateLimiter, fetchJson } from '../http';
import { quoteUnitOf } from './positions';
import { type RawTransfer, type SyncBudget, type SyncContext, type SyncResult, type WalletProvider, NATIVE } from './types';

const MAX_PAGES = 12;

interface BsItem {
  block_number: number;
  timestamp: string;
  transaction_hash: string;
  log_index: number;
  from: { hash: string };
  to: { hash: string };
  token: { address_hash?: string; address?: string; decimals: string | null; symbol: string | null; type: string };
  total: { value: string; decimals: string | null } | null;
}

const limiters = new Map<string, RateLimiter>();

export class BlockscoutProvider implements WalletProvider {
  async sync(chain: ChainSpec, address: string, source: WalletSource, cursor: Record<string, unknown> | null, budget: SyncBudget, ctx: SyncContext): Promise<SyncResult> {
    let limiter = limiters.get(source.url);
    if (!limiter) limiters.set(source.url, (limiter = new RateLimiter(60, Date.now, ctx.sleep)));
    const get = (path: string) =>
      fetchJson(`${source.url}${path}`, {
        limiter: limiter!,
        fetchImpl: ctx.fetchImpl,
        sleep: ctx.sleep,
        signal: ctx.signal,
        retries: 2,
        onRequest: (r) => ctx.health.record('blockscout', chain.id, r),
      });

    const wallet = address.toLowerCase();
    const lastBlock = typeof cursor?.lastBlock === 'number' ? cursor.lastBlock : null;
    const horizon = Date.now() - budget.backfillHours * 3600_000;
    const notes: string[] = [];
    const transfers: RawTransfer[] = [];
    let next: Record<string, unknown> | null = null;
    let reachedOld = false;
    let maxBlock = lastBlock ?? 0;

    for (let page = 0; page < MAX_PAGES && !reachedOld; page++) {
      if (Date.now() >= budget.deadline || ctx.signal?.aborted) break;
      const qs = new URLSearchParams({ type: 'ERC-20' });
      for (const [k, v] of Object.entries(next ?? {})) qs.set(k, String(v));
      const body = (await get(`/api/v2/addresses/${wallet}/token-transfers?${qs}`)) as { items?: BsItem[]; next_page_params?: Record<string, unknown> | null };
      for (const it of body.items ?? []) {
        if ((lastBlock !== null && it.block_number <= lastBlock) || (lastBlock === null && Date.parse(it.timestamp) < horizon)) {
          reachedOld = true;
          break;
        }
        maxBlock = Math.max(maxBlock, it.block_number);
        const fromA = it.from.hash.toLowerCase();
        const toA = it.to.hash.toLowerCase();
        if (fromA === toA || !it.total) continue;
        const decimals = it.total.decimals ?? it.token.decimals;
        transfers.push({
          txHash: it.transaction_hash.toLowerCase(),
          logIndex: it.log_index,
          blockNumber: it.block_number,
          blockTime: new Date(it.timestamp),
          tokenAddress: (it.token.address_hash ?? it.token.address ?? '').toLowerCase(),
          symbol: it.token.symbol,
          direction: toA === wallet ? 'in' : 'out',
          amountRaw: it.total.value,
          decimals: decimals === null ? null : Number(decimals),
          counterparty: toA === wallet ? fromA : toA,
        });
      }
      next = body.next_page_params ?? null;
      if (!next) reachedOld = true;
    }
    const complete = reachedOld;
    if (!complete) notes.push(`Loaded the newest ${transfers.length} transfers; older ones in this window were not reached this run.`);
    if (lastBlock === null) notes.push(`First sync: history from ~${budget.backfillHours}h back.`);

    // Native ETH sent with buys (tx.value), within budget.
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
        const tx = (await get(`/api/v2/transactions/${hash}`)) as { from?: { hash: string }; value?: string };
        if (tx.from?.hash.toLowerCase() === wallet && tx.value && BigInt(tx.value) > 0n) {
          const s = transfers.find((t) => t.txHash === hash)!;
          transfers.push({ txHash: hash, logIndex: -1, blockNumber: s.blockNumber, blockTime: s.blockTime, tokenAddress: NATIVE, symbol: chain.nativeAsset.symbol, direction: 'out', amountRaw: tx.value, decimals: chain.nativeAsset.decimals, counterparty: null });
        }
      } catch {
        // Unknown native leg → unknown cost.
      }
    }

    // Only advance the cursor past what we actually covered without a gap.
    // Re-fetching an overlap is harmless (rows are deduplicated by key).
    const nextCursor = complete ? { lastBlock: maxBlock } : lastBlock === null ? {} : { lastBlock };
    return { transfers, cursor: nextCursor, complete, notes };
  }
}
