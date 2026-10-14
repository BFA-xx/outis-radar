/**
 * Positions and PnL from a wallet's transfers. Pure; no I/O.
 *
 * A trade's price comes ONLY from the other legs of the same transaction:
 * a buy is "+TOKEN and −SOL/ETH/USDC in one tx"; a sell the reverse. Anything
 * else (a transfer in from another wallet, an airdrop, a multi-token route,
 * a sell paid in ETH via an internal transfer we cannot see) has an unknown
 * price, and every number that depends on it is reported as unknown — with
 * the reason — rather than guessed.
 *
 * Accounting is average cost, in the unit actually paid ("native" = SOL/ETH/
 * wrapped native; "usd" = stablecoins). A position paid in two different
 * units is not converted; it is marked incomplete.
 */
import { NATIVE } from './types';

export type QuoteUnit = 'native' | 'usd';

export interface TransferLike {
  /** Null when the token's decimals could not be read — the amount is then in raw units and unusable. */
  decimals?: number | null;
  txHash: string;
  blockTime: Date;
  tokenAddress: string;
  symbol: string | null;
  direction: 'in' | 'out' | string;
  amount: number;
}

export interface TradeEvent {
  txHash: string;
  at: Date;
  side: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  qty: number;
  /** Quote paid (buy) or received (sell), in `unit`. Null = not reconstructable. */
  quote: number | null;
  unit: QuoteUnit | null;
  /** Quote per token. */
  price: number | null;
  note?: string;
}

export interface Position {
  tokenAddress: string;
  symbol: string | null;
  unit: QuoteUnit | null;
  /** Net tokens received minus sent since tracking began. */
  netQty: number;
  boughtQty: number;
  soldQty: number;
  /** Average entry price, in unit per token — only when every acquisition has a known cost. */
  avgEntry: number | null;
  /** Cost of the tokens still held, in unit. */
  openCost: number | null;
  realized: number | null;
  firstEntryAt: Date | null;
  lastActivityAt: Date;
  events: TradeEvent[];
  complete: boolean;
  issues: string[];
}

/** Which tokens count as money, per chain, with their symbols. Canonical deployments only. */
export const QUOTE_TOKENS: Record<string, Record<string, { unit: QuoteUnit; symbol: string; decimals: number }>> = {
  solana: {
    So11111111111111111111111111111111111111112: { unit: 'native', symbol: 'wSOL', decimals: 9 },
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { unit: 'usd', symbol: 'USDC', decimals: 6 },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { unit: 'usd', symbol: 'USDT', decimals: 6 },
  },
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { unit: 'native', symbol: 'WETH', decimals: 18 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { unit: 'usd', symbol: 'USDC', decimals: 6 },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { unit: 'usd', symbol: 'USDT', decimals: 6 },
  },
  base: {
    '0x4200000000000000000000000000000000000006': { unit: 'native', symbol: 'WETH', decimals: 18 },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { unit: 'usd', symbol: 'USDC', decimals: 6 },
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { unit: 'native', symbol: 'WETH', decimals: 18 },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { unit: 'usd', symbol: 'USDC', decimals: 6 },
  },
  bsc: {
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { unit: 'native', symbol: 'WBNB', decimals: 18 },
    '0x55d398326f99059ff775485246999027b3197955': { unit: 'usd', symbol: 'USDT', decimals: 18 }, // BSC-USD has 18 decimals
  },
  // OP Stack chains share the WETH predeploy address.
  optimism: { '0x4200000000000000000000000000000000000006': { unit: 'native', symbol: 'WETH', decimals: 18 } },
  unichain: { '0x4200000000000000000000000000000000000006': { unit: 'native', symbol: 'WETH', decimals: 18 } },
  ink: { '0x4200000000000000000000000000000000000006': { unit: 'native', symbol: 'WETH', decimals: 18 } },
  avalanche: { '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': { unit: 'native', symbol: 'WAVAX', decimals: 18 } },
};

export function quoteUnitOf(chainId: string, token: string): QuoteUnit | null {
  if (token === NATIVE) return 'native';
  return QUOTE_TOKENS[chainId]?.[token]?.unit ?? null;
}

const EPS = 1e-12;

export function computePositions(chainId: string, allTransfers: TransferLike[]): Position[] {
  // Amounts with unknown decimals are raw integers, not quantities; leave them out entirely.
  const unscaled = new Set(allTransfers.filter((t) => t.decimals === null).map((t) => t.tokenAddress));
  const transfers = allTransfers.filter((t) => t.decimals !== null);
  // Group by transaction, in time order.
  const byTx = new Map<string, TransferLike[]>();
  for (const t of [...transfers].sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime())) {
    const list = byTx.get(t.txHash) ?? [];
    list.push(t);
    byTx.set(t.txHash, list);
  }

  const positions = new Map<string, Position>();
  const pos = (token: string, symbol: string | null, at: Date): Position => {
    let p = positions.get(token);
    if (!p) {
      p = { tokenAddress: token, symbol, unit: null, netQty: 0, boughtQty: 0, soldQty: 0, avgEntry: null, openCost: 0, realized: 0, firstEntryAt: null, lastActivityAt: at, events: [], complete: true, issues: [] };
      positions.set(token, p);
    }
    if (!p.symbol && symbol) p.symbol = symbol;
    return p;
  };
  const issue = (p: Position, text: string) => {
    p.complete = false;
    if (!p.issues.includes(text)) p.issues.push(text);
  };

  for (const [txHash, legs] of byTx) {
    const at = legs[0].blockTime;
    // Net change per asset in this tx.
    const net = new Map<string, { amount: number; symbol: string | null }>();
    for (const l of legs) {
      const e = net.get(l.tokenAddress) ?? { amount: 0, symbol: l.symbol };
      e.amount += l.direction === 'in' ? l.amount : -l.amount;
      net.set(l.tokenAddress, e);
    }
    const quoteNet: Record<QuoteUnit, number> = { native: 0, usd: 0 };
    const tokens: Array<[string, { amount: number; symbol: string | null }]> = [];
    for (const [addr, e] of net) {
      const unit = quoteUnitOf(chainId, addr);
      if (unit) quoteNet[unit] += e.amount;
      else if (Math.abs(e.amount) > EPS) tokens.push([addr, e]);
    }

    for (const [addr, e] of tokens) {
      const p = pos(addr, e.symbol, at);
      p.lastActivityAt = at;
      const qty = Math.abs(e.amount);
      const isIn = e.amount > 0;
      // Price is only attributable when this token is the ONLY non-money asset in the tx,
      // and money moved the opposite way in exactly one unit.
      const usedUnits = (Object.keys(quoteNet) as QuoteUnit[]).filter((u) => Math.abs(quoteNet[u]) > EPS);
      const opposite = usedUnits.filter((u) => (isIn ? quoteNet[u] < 0 : quoteNet[u] > 0));
      let quote: number | null = null;
      let unit: QuoteUnit | null = null;
      let why: string | undefined;
      if (tokens.length > 1) why = 'Several tokens moved in one transaction; the price cannot be split between them.';
      else if (opposite.length === 0) why = isIn ? 'Received without a payment leg in the same transaction (transfer, airdrop, or paid in a way we cannot see).' : 'Sent without proceeds in the same transaction (transfer, or proceeds arrived as an internal transfer we cannot see).';
      else if (opposite.length > 1) why = 'Paid in two different currencies in one transaction.';
      else {
        unit = opposite[0];
        quote = Math.abs(quoteNet[unit]);
      }

      if (isIn) {
        p.netQty += qty;
        p.boughtQty += qty;
        p.firstEntryAt ??= at;
        if (quote !== null && unit) {
          if (p.unit && p.unit !== unit) issue(p, `Bought in both ${p.unit} and ${unit}; costs are not combined.`);
          p.unit ??= unit;
          if (p.openCost !== null) p.openCost += quote;
          p.events.push({ txHash, at, side: 'buy', qty, quote, unit, price: quote / qty });
        } else {
          p.openCost = null; // cost of the holding is no longer known
          issue(p, why ?? 'Unknown acquisition cost.');
          p.events.push({ txHash, at, side: 'transfer_in', qty, quote: null, unit: null, price: null, note: why });
        }
      } else {
        const heldBefore = p.netQty;
        if (heldBefore + EPS < qty) issue(p, 'Sold more than was bought since tracking began — part of the position predates tracking.');
        const share = heldBefore > EPS ? Math.min(qty / heldBefore, 1) : 1;
        const costOut = p.openCost !== null && heldBefore > EPS && heldBefore + EPS >= qty ? p.openCost * share : null;
        if (quote !== null && unit) {
          if (p.unit && p.unit !== unit) issue(p, `Sold for ${unit} after buying with ${p.unit}; not converted.`);
          p.unit ??= unit;
          if (costOut !== null && p.realized !== null && p.unit === unit) p.realized += quote - costOut;
          else {
            p.realized = null;
            if (costOut === null) issue(p, 'A sale’s cost basis is unknown, so realized PnL is unknown.');
          }
          p.events.push({ txHash, at, side: 'sell', qty, quote, unit, price: quote / qty });
        } else {
          p.realized = null;
          issue(p, why ?? 'Unknown sale proceeds.');
          p.events.push({ txHash, at, side: 'transfer_out', qty, quote: null, unit: null, price: null, note: why });
        }
        if (p.openCost !== null) p.openCost = costOut === null ? null : p.openCost - costOut;
        p.netQty = Math.max(0, heldBefore - qty);
        p.soldQty += qty;
        if (p.netQty <= EPS) {
          // Flat again: whatever was unknown about the old holding no longer affects new buys.
          p.netQty = 0;
          p.openCost = 0;
        }
      }
    }
  }

  for (const p of positions.values()) {
    const buys = p.events.filter((e) => e.side === 'buy');
    const allKnown = p.events.every((e) => e.side !== 'transfer_in');
    if (allKnown && buys.length > 0) {
      const q = buys.reduce((s, e) => s + e.qty, 0);
      const c = buys.reduce((s, e) => s + (e.quote ?? 0), 0);
      p.avgEntry = q > 0 ? c / q : null;
    }
  }
  for (const token of unscaled) {
    const p = positions.get(token);
    if (p) issue(p, 'Some transfers of this token have an unknown decimal scale and were left out.');
  }
  return [...positions.values()].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

/**
 * Value an open position at the current price. `priceInUnit` must be quoted
 * in the position's unit (SOL per token for "native" on Solana, USD for "usd").
 */
export function valuePosition(p: Position, priceInUnit: number | null): { value: number | null; unrealized: number | null } {
  if (priceInUnit === null || p.netQty === 0) return { value: p.netQty === 0 ? 0 : null, unrealized: p.netQty === 0 ? 0 : null };
  const value = p.netQty * priceInUnit;
  return { value, unrealized: p.openCost === null ? null : value - p.openCost };
}

export interface CashFlow {
  tokenAddress: string;
  symbol: string;
  unit: QuoteUnit;
  received: number;
  sent: number;
  transfers: number;
}

/** Money (native, wrapped native, stablecoins) in and out of the wallet. */
export function cashFlows(chainId: string, nativeSymbol: string, transfers: TransferLike[]): CashFlow[] {
  const out = new Map<string, CashFlow>();
  for (const t of transfers) {
    const unit = quoteUnitOf(chainId, t.tokenAddress);
    if (!unit || t.decimals === null) continue;
    const symbol = t.tokenAddress === NATIVE ? nativeSymbol : (QUOTE_TOKENS[chainId]?.[t.tokenAddress]?.symbol ?? t.symbol ?? '?');
    const f = out.get(t.tokenAddress) ?? { tokenAddress: t.tokenAddress, symbol, unit, received: 0, sent: 0, transfers: 0 };
    if (t.direction === 'in') f.received += t.amount;
    else f.sent += t.amount;
    f.transfers++;
    out.set(t.tokenAddress, f);
  }
  return [...out.values()].sort((a, b) => b.transfers - a.transfers);
}
