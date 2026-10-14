/**
 * Provider-independent market data shapes.
 *
 * Every provider adapter turns its own response into `PairObservation`s. The
 * rest of the system (merging, persistence, scoring, the API) only ever sees
 * this shape, so adding a provider never touches anything downstream.
 *
 * `null` always means "the source did not report this". It never means zero,
 * and nothing downstream is allowed to treat it as zero.
 */

export const WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const;
export type Window = (typeof WINDOWS)[number];

export interface TxnCounts {
  buys: number | null;
  sells: number | null;
  /** Distinct buying wallets. Only some sources report this. */
  buyers: number | null;
  sellers: number | null;
}

export interface TokenRef {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  imageUrl: string | null;
}

export type ProviderId = 'geckoterminal' | 'dexscreener';

/** Why this pair entered the pipeline. A paid boost is recorded, never treated as quality. */
export type DiscoveryReason =
  | 'new_pool'
  | 'token_profile'
  | 'token_boost'
  | 'community_takeover'
  /** Traded by a wallet the user tracks. */
  | 'wallet_activity'
  /** Someone searched for it (website search or a CA pasted into the bot). */
  | 'lookup'
  | 'refresh';

export interface PairObservation {
  chainId: string;
  pairAddress: string;
  dexId: string | null;
  baseToken: TokenRef;
  quoteToken: TokenRef;
  pairCreatedAt: Date | null;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volumeUsd: Record<Window, number | null>;
  txns: Record<Window, TxnCounts>;
  priceChangePct: Record<Window, number | null>;
  url: string | null;
  source: ProviderId;
  reason: DiscoveryReason;
  observedAt: Date;
  /**
   * Fields the source itself flags as estimated/derived rather than measured.
   * e.g. FDV is always price × total supply as computed by the provider.
   */
  estimatedFields: string[];
}

/**
 * Which source supplied each field after merging observations of one pair.
 * Stored alongside the pair so the dashboard can attribute every number.
 */
export type FieldSources = Partial<Record<string, ProviderId>>;

export function emptyWindows<T>(value: T): Record<Window, T> {
  return { m5: value, h1: value, h6: value, h24: value };
}

export function emptyTxns(): Record<Window, TxnCounts> {
  return {
    m5: { buys: null, sells: null, buyers: null, sellers: null },
    h1: { buys: null, sells: null, buyers: null, sellers: null },
    h6: { buys: null, sells: null, buyers: null, sellers: null },
    h24: { buys: null, sells: null, buyers: null, sellers: null },
  };
}

/** How fresh a stored value is, for the dashboard's freshness badges. */
export type Freshness = 'live' | 'recent' | 'stale' | 'unavailable';

export function freshnessOf(updatedAt: Date | string | null | undefined, now = new Date()): Freshness {
  if (!updatedAt) return 'unavailable';
  const ageMs = now.getTime() - new Date(updatedAt).getTime();
  if (ageMs <= 10 * 60_000) return 'live';
  if (ageMs <= 60 * 60_000) return 'recent';
  return 'stale';
}
