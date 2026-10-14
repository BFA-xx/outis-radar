/**
 * Merging: many observations of the same pair (from different providers, or
 * the same provider through different feeds) become one record per pair.
 *
 * Rules:
 *  - Identity is (chainId, normalized pairAddress). Nothing else.
 *  - Within a pair, each field is taken from the highest-priority source that
 *    reported a non-null value, and the winning source is recorded per field.
 *    A null never overwrites a value from a lower-priority source.
 *  - Pair creation time is the EARLIEST reported, since providers that first
 *    indexed the pair late report their indexing time, never an earlier one.
 *  - Every original observation is kept (`observations`) so each source still
 *    gets its own snapshot row.
 */
import {
  type DiscoveryReason,
  type FieldSources,
  type PairObservation,
  type ProviderId,
  type TokenRef,
  type TxnCounts,
  type Window,
  WINDOWS,
  emptyTxns,
  emptyWindows,
} from '@outis/shared';

export const DEFAULT_PROVIDER_PRIORITY: ProviderId[] = ['geckoterminal', 'dexscreener'];

export interface MergedPair {
  chainId: string;
  pairAddress: string;
  dexId: string | null;
  baseToken: TokenRef;
  quoteToken: TokenRef;
  pairCreatedAt: Date | null;
  pairCreatedAtSource: ProviderId | null;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volumeUsd: Record<Window, number | null>;
  txns: Record<Window, TxnCounts>;
  priceChangePct: Record<Window, number | null>;
  url: string | null;
  reasons: DiscoveryReason[];
  fieldSources: FieldSources;
  estimatedFields: string[];
  /** Newest observation time among the merged inputs. */
  observedAt: Date;
  observations: PairObservation[];
}

export function pairKey(o: { chainId: string; pairAddress: string }): string {
  return `${o.chainId}:${o.pairAddress}`;
}

function pick<T>(
  sorted: PairObservation[],
  field: string,
  get: (o: PairObservation) => T | null,
  sources: FieldSources,
): T | null {
  for (const o of sorted) {
    const v = get(o);
    if (v !== null && v !== undefined) {
      sources[field] = o.source;
      return v;
    }
  }
  return null;
}

function mergeToken(sorted: PairObservation[], side: 'baseToken' | 'quoteToken'): TokenRef {
  // Base/quote orientation comes from the top-priority observation; metadata
  // from others only if they agree on the address.
  const address = sorted[0][side].address;
  const agreeing = sorted.filter((o) => o[side].address === address);
  const first = <K extends keyof TokenRef>(k: K): TokenRef[K] =>
    (agreeing.map((o) => o[side][k]).find((v) => v !== null && v !== undefined) ?? null) as TokenRef[K];
  return {
    address,
    symbol: first('symbol'),
    name: first('name'),
    decimals: first('decimals'),
    imageUrl: first('imageUrl'),
  };
}

export function mergeObservations(
  observations: PairObservation[],
  priority: ProviderId[] = DEFAULT_PROVIDER_PRIORITY,
): MergedPair[] {
  const groups = new Map<string, PairObservation[]>();
  for (const o of observations) {
    const key = pairKey(o);
    const g = groups.get(key);
    if (g) g.push(o);
    else groups.set(key, [o]);
  }

  const rank = (p: ProviderId) => {
    const i = priority.indexOf(p);
    return i === -1 ? priority.length : i;
  };

  const merged: MergedPair[] = [];
  for (const group of groups.values()) {
    // Priority first; within a provider, the newest observation wins.
    const sorted = [...group].sort(
      (a, b) => rank(a.source) - rank(b.source) || b.observedAt.getTime() - a.observedAt.getTime(),
    );
    const sources: FieldSources = {};

    const volumeUsd = emptyWindows<number | null>(null);
    const priceChangePct = emptyWindows<number | null>(null);
    const txns = emptyTxns();
    for (const w of WINDOWS) {
      volumeUsd[w] = pick(sorted, `volume.${w}`, (o) => o.volumeUsd[w], sources);
      priceChangePct[w] = pick(sorted, `priceChange.${w}`, (o) => o.priceChangePct[w], sources);
      txns[w] = {
        buys: pick(sorted, `txns.${w}.buys`, (o) => o.txns[w].buys, sources),
        sells: pick(sorted, `txns.${w}.sells`, (o) => o.txns[w].sells, sources),
        buyers: pick(sorted, `txns.${w}.buyers`, (o) => o.txns[w].buyers, sources),
        sellers: pick(sorted, `txns.${w}.sellers`, (o) => o.txns[w].sellers, sources),
      };
    }

    const created = group
      .filter((o) => o.pairCreatedAt)
      .sort((a, b) => a.pairCreatedAt!.getTime() - b.pairCreatedAt!.getTime())[0];

    const fieldsTaken = (field: string) => sources[field];
    const priceUsd = pick(sorted, 'priceUsd', (o) => o.priceUsd, sources);
    const priceNative = pick(sorted, 'priceNative', (o) => o.priceNative, sources);
    const liquidityUsd = pick(sorted, 'liquidityUsd', (o) => o.liquidityUsd, sources);
    const fdvUsd = pick(sorted, 'fdvUsd', (o) => o.fdvUsd, sources);
    const marketCapUsd = pick(sorted, 'marketCapUsd', (o) => o.marketCapUsd, sources);

    // A field is estimated if the observation that supplied it said so.
    const estimatedFields = ['fdvUsd', 'marketCapUsd', 'liquidityUsd'].filter((f) => {
      const src = fieldsTaken(f);
      return src !== undefined && sorted.find((o) => o.source === src)?.estimatedFields.includes(f);
    });

    merged.push({
      chainId: sorted[0].chainId,
      pairAddress: sorted[0].pairAddress,
      dexId: pick(sorted, 'dexId', (o) => o.dexId, sources),
      baseToken: mergeToken(sorted, 'baseToken'),
      quoteToken: mergeToken(sorted, 'quoteToken'),
      pairCreatedAt: created?.pairCreatedAt ?? null,
      pairCreatedAtSource: created?.source ?? null,
      priceUsd,
      priceNative,
      liquidityUsd,
      fdvUsd,
      marketCapUsd,
      volumeUsd,
      txns,
      priceChangePct,
      url: pick(sorted, 'url', (o) => o.url, sources),
      reasons: [...new Set(group.map((o) => o.reason))],
      fieldSources: sources,
      estimatedFields,
      observedAt: new Date(Math.max(...group.map((o) => o.observedAt.getTime()))),
      observations: group,
    });
  }
  return merged;
}

/** Sum that is null unless every part is known — a half-known total is not a total. */
export function sumKnown(...values: Array<number | null>): number | null {
  if (values.some((v) => v === null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0);
}
