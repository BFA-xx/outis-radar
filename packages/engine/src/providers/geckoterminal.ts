/**
 * GeckoTerminal public API (no key). Our new-pair feed: `/networks/{n}/new_pools`
 * lists pools in creation order, newest first, 20 per page.
 *
 * Documented limit is 30 calls/minute, but on 2026-10-11 it returned 429s
 * at ~11/min within 30 seconds (measured), so we run at 6/min and treat a 429
 * as a full-minute pause (see GT_RATE_LIMIT_PAUSE_MS). A scan of N chains costs
 * roughly N + (priority-1 chains × extra pages) calls — budget scans accordingly.
 * It is the only source we use that reports distinct buyers/sellers.
 */
import { z } from 'zod';
import {
  type ChainSpec,
  type PairObservation,
  type TokenRef,
  type TxnCounts,
  WINDOWS,
  emptyTxns,
  emptyWindows,
  normalizeAddress,
} from '@outis/shared';
import { RateLimiter, fetchJson } from '../http';
import { date, int, num, str } from './parse';
import type { ProviderContext, ProviderResult } from './types';

export const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
/** GT sends no Retry-After; its window is a minute, so retrying sooner only burns budget. */
export const GT_RATE_LIMIT_PAUSE_MS = 60_000;

const txnWindow = z
  .object({
    buys: z.unknown().optional(),
    sells: z.unknown().optional(),
    buyers: z.unknown().optional(),
    sellers: z.unknown().optional(),
  })
  .passthrough();

const poolSchema = z.object({
  id: z.string(),
  type: z.literal('pool'),
  attributes: z
    .object({
      address: z.string().min(1),
      name: z.string().nullish(),
      pool_created_at: z.string().nullish(),
      base_token_price_usd: z.unknown().optional(),
      base_token_price_native_currency: z.unknown().optional(),
      fdv_usd: z.unknown().optional(),
      market_cap_usd: z.unknown().optional(),
      reserve_in_usd: z.unknown().optional(),
      price_change_percentage: z.record(z.unknown()).nullish(),
      transactions: z.record(txnWindow).nullish(),
      volume_usd: z.record(z.unknown()).nullish(),
    })
    .passthrough(),
  relationships: z
    .object({
      base_token: z.object({ data: z.object({ id: z.string() }).nullable() }),
      quote_token: z.object({ data: z.object({ id: z.string() }).nullable() }),
      dex: z.object({ data: z.object({ id: z.string() }).nullable() }).optional(),
    })
    .passthrough(),
});

const includedTokenSchema = z.object({
  id: z.string(),
  type: z.literal('token'),
  attributes: z
    .object({
      address: z.string(),
      name: z.string().nullish(),
      symbol: z.string().nullish(),
      decimals: z.unknown().optional(),
      image_url: z.string().nullish(),
    })
    .passthrough(),
});

const envelopeSchema = z.object({
  data: z.array(z.unknown()),
  included: z.array(z.unknown()).optional(),
});

/** GT's ids are "<network>_<address>"; addresses may themselves contain "_" on some chains. */
function addressFromId(id: string, network: string): string {
  return id.startsWith(`${network}_`) ? id.slice(network.length + 1) : id;
}

/** GT uses "missing.png" placeholders for tokens with no image. */
function imageOrNull(url: string | null | undefined): string | null {
  const s = str(url);
  return s && !s.endsWith('missing.png') ? s : null;
}

export function normalizeGeckoTerminalPools(
  chain: ChainSpec,
  body: unknown,
  observedAt: Date,
): ProviderResult<PairObservation[]> {
  const network = chain.providerIds.geckoterminal;
  if (!network) return { data: [], malformed: 0, errors: [`${chain.id} is not on GeckoTerminal`] };

  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return { data: [], malformed: 0, errors: ['GeckoTerminal: unexpected response shape'] };

  const tokens = new Map<string, TokenRef>();
  for (const raw of envelope.data.included ?? []) {
    const t = includedTokenSchema.safeParse(raw);
    if (!t.success) continue;
    tokens.set(t.data.id, {
      address: normalizeAddress(chain, t.data.attributes.address),
      symbol: str(t.data.attributes.symbol),
      name: str(t.data.attributes.name),
      decimals: int(t.data.attributes.decimals),
      imageUrl: imageOrNull(t.data.attributes.image_url),
    });
  }

  const out: PairObservation[] = [];
  let malformed = 0;
  for (const raw of envelope.data.data) {
    const parsed = poolSchema.safeParse(raw);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    const pool = parsed.data;
    const a = pool.attributes;
    const baseId = pool.relationships.base_token.data?.id;
    const quoteId = pool.relationships.quote_token.data?.id;
    if (!baseId || !quoteId) {
      malformed++;
      continue;
    }
    const tokenRef = (id: string): TokenRef =>
      tokens.get(id) ?? {
        address: normalizeAddress(chain, addressFromId(id, network)),
        symbol: null,
        name: null,
        decimals: null,
        imageUrl: null,
      };

    const txns = emptyTxns();
    const volumeUsd = emptyWindows<number | null>(null);
    const priceChangePct = emptyWindows<number | null>(null);
    for (const w of WINDOWS) {
      const t = a.transactions?.[w];
      if (t) {
        const counts: TxnCounts = {
          buys: int(t.buys),
          sells: int(t.sells),
          buyers: int(t.buyers),
          sellers: int(t.sellers),
        };
        txns[w] = counts;
      }
      volumeUsd[w] = num(a.volume_usd?.[w]);
      priceChangePct[w] = num(a.price_change_percentage?.[w]);
    }

    const pairAddress = normalizeAddress(chain, a.address);
    out.push({
      chainId: chain.id,
      pairAddress,
      dexId: str(pool.relationships.dex?.data?.id),
      baseToken: tokenRef(baseId),
      quoteToken: tokenRef(quoteId),
      pairCreatedAt: date(a.pool_created_at),
      priceUsd: num(a.base_token_price_usd),
      priceNative: num(a.base_token_price_native_currency),
      liquidityUsd: num(a.reserve_in_usd),
      fdvUsd: num(a.fdv_usd),
      marketCapUsd: num(a.market_cap_usd),
      volumeUsd,
      txns,
      priceChangePct,
      url: `https://www.geckoterminal.com/${network}/pools/${a.address}`,
      source: 'geckoterminal',
      reason: 'new_pool',
      observedAt,
      // Both are price × a supply figure GT derives; neither is a measured quantity.
      estimatedFields: ['fdvUsd', 'marketCapUsd'],
    });
  }
  return { data: out, malformed, errors: [] };
}

export class GeckoTerminalProvider {
  readonly id = 'geckoterminal' as const;
  readonly limiter: RateLimiter;

  constructor(
    private readonly ctx: ProviderContext,
    perMinute = 6,
    private readonly baseUrl = GECKOTERMINAL_BASE,
  ) {
    this.limiter = new RateLimiter(perMinute, Date.now, ctx.sleep);
  }

  supports(chain: ChainSpec): boolean {
    return Boolean(chain.providerIds.geckoterminal);
  }

  /** Newest pools first. Stops early on an error page instead of failing the chain. */
  async newPools(chain: ChainSpec, pages: number): Promise<ProviderResult<PairObservation[]>> {
    const network = chain.providerIds.geckoterminal;
    if (!network) return { data: [], malformed: 0, errors: [] };
    const result: ProviderResult<PairObservation[]> = { data: [], malformed: 0, errors: [] };
    const seen = new Set<string>();

    for (let page = 1; page <= pages; page++) {
      const url = `${this.baseUrl}/networks/${network}/new_pools?include=base_token,quote_token,dex&page=${page}`;
      let body: unknown;
      try {
        body = await fetchJson(url, {
          limiter: this.limiter,
          fetchImpl: this.ctx.fetchImpl,
          sleep: this.ctx.sleep,
          signal: this.ctx.signal,
          onRequest: (r) => this.ctx.health.record(this.id, chain.id, r),
          rateLimitPauseMs: GT_RATE_LIMIT_PAUSE_MS,
          retries: 2,
        });
      } catch (err) {
        result.errors.push((err as Error).message);
        break;
      }
      const now = this.ctx.now?.() ?? new Date();
      const pageResult = normalizeGeckoTerminalPools(chain, body, now);
      result.malformed += pageResult.malformed;
      result.errors.push(...pageResult.errors);
      // Pages shift while we read them (new pools push old ones down); drop repeats.
      for (const o of pageResult.data) {
        if (seen.has(o.pairAddress)) continue;
        seen.add(o.pairAddress);
        result.data.push(o);
      }
      if (pageResult.data.length < 20) break;
    }
    return result;
  }
}
