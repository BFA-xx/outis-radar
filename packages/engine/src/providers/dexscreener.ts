/**
 * DEX Screener public API (no key).
 *
 *  - /token-profiles, /token-boosts, /community-takeovers (60 req/min): tokens
 *    that projects have paid to list or promote. That is a DISCOVERY channel,
 *    not a quality signal — the reason is stored so scoring can discount it.
 *  - /tokens/v1 and /latest/dex/pairs (300 req/min, 30 ids per call): market
 *    data for tokens/pairs we already know about. This is our refresh path.
 *
 * DEX Screener does not report liquidity for some pair types (e.g. pump.fun
 * bonding curves). Those stay null.
 */
import { z } from 'zod';
import {
  type ChainSpec,
  type DiscoveryReason,
  type PairObservation,
  type TokenLinks,
  WINDOWS,
  chainByProviderId,
  emptyTxns,
  emptyWindows,
  normalizeAddress,
} from '@outis/shared';
import { RateLimiter, fetchJson } from '../http';
import { date, int, num, str } from './parse';
import type { DiscoveredTokenRef, ProviderContext, ProviderResult } from './types';

export const DEXSCREENER_BASE = 'https://api.dexscreener.com';
export const DEXSCREENER_BATCH = 30;

const tokenSchema = z.object({
  address: z.string().min(1),
  name: z.string().nullish(),
  symbol: z.string().nullish(),
});

const pairSchema = z
  .object({
    chainId: z.string(),
    dexId: z.string().nullish(),
    url: z.string().nullish(),
    pairAddress: z.string().min(1),
    baseToken: tokenSchema,
    quoteToken: tokenSchema,
    priceNative: z.unknown().optional(),
    priceUsd: z.unknown().optional(),
    txns: z.record(z.object({ buys: z.unknown().optional(), sells: z.unknown().optional() }).passthrough()).nullish(),
    volume: z.record(z.unknown()).nullish(),
    priceChange: z.record(z.unknown()).nullish(),
    liquidity: z.object({ usd: z.unknown().optional() }).passthrough().nullish(),
    fdv: z.unknown().optional(),
    marketCap: z.unknown().optional(),
    pairCreatedAt: z.unknown().optional(),
    info: z
      .object({
        imageUrl: z.string().nullish(),
        websites: z.array(z.object({ url: z.string() }).passthrough()).nullish(),
        socials: z.array(z.object({ type: z.string().nullish(), url: z.string() }).passthrough()).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const listingSchema = z.object({ chainId: z.string(), tokenAddress: z.string().min(1) }).passthrough();

/** Only http(s) links — they end up as tappable links in Telegram and on the dashboard. */
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : undefined);

function dsLinks(info: { websites?: Array<{ url: string }> | null; socials?: Array<{ type?: string | null; url: string }> | null } | null | undefined): TokenLinks | null {
  if (!info) return null;
  const social = (t: string) => safeUrl(info.socials?.find((s) => s.type?.toLowerCase() === t)?.url);
  const links: TokenLinks = { website: safeUrl(info.websites?.[0]?.url), twitter: social('twitter') ?? social('x'), telegram: social('telegram') };
  for (const k of Object.keys(links) as Array<keyof TokenLinks>) if (!links[k]) delete links[k];
  return Object.keys(links).length ? links : null;
}

export function normalizeDexScreenerPairs(
  body: unknown,
  observedAt: Date,
  reason: DiscoveryReason,
  /** Only keep pairs on these chains (DS sometimes returns cross-chain results). */
  chains: ChainSpec[],
): ProviderResult<PairObservation[]> {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { pairs?: unknown }).pairs)
      ? (body as { pairs: unknown[] }).pairs
      : body && typeof body === 'object' && (body as { pairs?: unknown }).pairs === null
        ? []
        : null;
  if (list === null) return { data: [], malformed: 0, errors: ['DEX Screener: unexpected response shape'] };

  const allowed = new Set(chains.map((c) => c.id));
  const out: PairObservation[] = [];
  let malformed = 0;

  for (const raw of list) {
    const parsed = pairSchema.safeParse(raw);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    const p = parsed.data;
    const chain = chainByProviderId('dexscreener', p.chainId);
    if (!chain || !allowed.has(chain.id)) continue;

    const txns = emptyTxns();
    const volumeUsd = emptyWindows<number | null>(null);
    const priceChangePct = emptyWindows<number | null>(null);
    for (const w of WINDOWS) {
      const t = p.txns?.[w];
      // DEX Screener reports counts only, never distinct wallets.
      if (t) txns[w] = { buys: int(t.buys), sells: int(t.sells), buyers: null, sellers: null };
      volumeUsd[w] = num(p.volume?.[w]);
      priceChangePct[w] = num(p.priceChange?.[w]);
    }

    out.push({
      chainId: chain.id,
      pairAddress: normalizeAddress(chain, p.pairAddress),
      dexId: str(p.dexId),
      baseToken: {
        address: normalizeAddress(chain, p.baseToken.address),
        symbol: str(p.baseToken.symbol),
        name: str(p.baseToken.name),
        decimals: null,
        imageUrl: str(p.info?.imageUrl),
        links: dsLinks(p.info),
      },
      quoteToken: {
        address: normalizeAddress(chain, p.quoteToken.address),
        symbol: str(p.quoteToken.symbol),
        name: str(p.quoteToken.name),
        decimals: null,
        imageUrl: null,
      },
      pairCreatedAt: date(p.pairCreatedAt),
      priceUsd: num(p.priceUsd),
      priceNative: num(p.priceNative),
      liquidityUsd: num(p.liquidity?.usd),
      fdvUsd: num(p.fdv),
      marketCapUsd: num(p.marketCap),
      volumeUsd,
      txns,
      priceChangePct,
      url: str(p.url),
      source: 'dexscreener',
      reason,
      observedAt,
      estimatedFields: ['fdvUsd', 'marketCapUsd'],
    });
  }
  return { data: out, malformed, errors: [] };
}

export function normalizeDexScreenerListings(
  body: unknown,
  reason: DiscoveryReason,
  chains: ChainSpec[],
): ProviderResult<DiscoveredTokenRef[]> {
  if (!Array.isArray(body)) return { data: [], malformed: 0, errors: ['DEX Screener: listing is not an array'] };
  const allowed = new Set(chains.map((c) => c.id));
  const out: DiscoveredTokenRef[] = [];
  let malformed = 0;
  for (const raw of body) {
    const parsed = listingSchema.safeParse(raw);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    const chain = chainByProviderId('dexscreener', parsed.data.chainId);
    if (!chain || !allowed.has(chain.id)) continue;
    out.push({ chain, tokenAddress: normalizeAddress(chain, parsed.data.tokenAddress), reason });
  }
  return { data: out, malformed, errors: [] };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class DexScreenerProvider {
  readonly id = 'dexscreener' as const;
  /** Profiles/boosts/takeovers: 60/min. */
  readonly listingLimiter: RateLimiter;
  /** tokens/pairs: 300/min. */
  readonly dataLimiter: RateLimiter;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly baseUrl = DEXSCREENER_BASE,
  ) {
    this.listingLimiter = new RateLimiter(50, Date.now, ctx.sleep);
    this.dataLimiter = new RateLimiter(240, Date.now, ctx.sleep);
  }

  supports(chain: ChainSpec): boolean {
    return Boolean(chain.providerIds.dexscreener);
  }

  private async get(url: string, limiter: RateLimiter, scope: string): Promise<unknown> {
    return fetchJson(url, {
      limiter,
      fetchImpl: this.ctx.fetchImpl,
      sleep: this.ctx.sleep,
      signal: this.ctx.signal,
      onRequest: (r) => this.ctx.health.record(this.id, scope, r),
    });
  }

  /** Recently listed/promoted tokens on the given chains, deduplicated. */
  async latestListings(chains: ChainSpec[]): Promise<ProviderResult<DiscoveredTokenRef[]>> {
    const feeds: Array<[string, DiscoveryReason]> = [
      ['/token-profiles/latest/v1', 'token_profile'],
      ['/community-takeovers/latest/v1', 'community_takeover'],
      ['/token-boosts/latest/v1', 'token_boost'],
    ];
    const result: ProviderResult<DiscoveredTokenRef[]> = { data: [], malformed: 0, errors: [] };
    const seen = new Set<string>();
    for (const [path, reason] of feeds) {
      try {
        const body = await this.get(this.baseUrl + path, this.listingLimiter, '*');
        const r = normalizeDexScreenerListings(body, reason, chains);
        result.malformed += r.malformed;
        result.errors.push(...r.errors);
        for (const ref of r.data) {
          const key = `${ref.chain.id}:${ref.tokenAddress}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.data.push(ref);
        }
      } catch (err) {
        result.errors.push((err as Error).message);
      }
    }
    return result;
  }

  /** All pairs for up to N token addresses, batched 30 per call. */
  async pairsForTokens(
    chain: ChainSpec,
    tokenAddresses: string[],
    reasonFor: (tokenAddress: string) => DiscoveryReason,
  ): Promise<ProviderResult<PairObservation[]>> {
    return this.batched(chain, tokenAddresses, (ids) => `/tokens/v1/${chain.providerIds.dexscreener}/${ids}`, (o) =>
      reasonFor(o.baseToken.address),
    );
  }

  /**
   * Every pool for one address, on any chain: as a token first
   * (`/latest/dex/tokens`), then as a pool address via search.
   */
  async searchToken(address: string, chains: ChainSpec[]): Promise<ProviderResult<PairObservation[]>> {
    const result: ProviderResult<PairObservation[]> = { data: [], malformed: 0, errors: [] };
    for (const path of [`/latest/dex/tokens/${encodeURIComponent(address)}`, `/latest/dex/search?q=${encodeURIComponent(address)}`]) {
      try {
        const body = await this.get(this.baseUrl + path, this.dataLimiter, '*');
        const r = normalizeDexScreenerPairs(body, this.ctx.now?.() ?? new Date(), 'refresh', chains);
        result.malformed += r.malformed;
        result.errors.push(...r.errors);
        result.data.push(...r.data);
        if (r.data.length > 0) break;
      } catch (err) {
        result.errors.push((err as Error).message);
      }
    }
    return result;
  }

  /** Current market data for known pairs, batched 30 per call. */
  async refreshPairs(chain: ChainSpec, pairAddresses: string[]): Promise<ProviderResult<PairObservation[]>> {
    return this.batched(
      chain,
      pairAddresses,
      (ids) => `/latest/dex/pairs/${chain.providerIds.dexscreener}/${ids}`,
      () => 'refresh',
    );
  }

  private async batched(
    chain: ChainSpec,
    ids: string[],
    path: (joined: string) => string,
    reasonFor: (o: PairObservation) => DiscoveryReason,
  ): Promise<ProviderResult<PairObservation[]>> {
    const result: ProviderResult<PairObservation[]> = { data: [], malformed: 0, errors: [] };
    if (!chain.providerIds.dexscreener) return result;
    for (const batch of chunk([...new Set(ids)], DEXSCREENER_BATCH)) {
      if (this.ctx.signal?.aborted) break;
      try {
        const body = await this.get(this.baseUrl + path(batch.join(',')), this.dataLimiter, chain.id);
        const now = this.ctx.now?.() ?? new Date();
        const r = normalizeDexScreenerPairs(body, now, 'refresh', [chain]);
        result.malformed += r.malformed;
        result.errors.push(...r.errors);
        for (const o of r.data) result.data.push({ ...o, reason: reasonFor(o) });
      } catch (err) {
        result.errors.push((err as Error).message);
      }
    }
    return result;
  }
}
