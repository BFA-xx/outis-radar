/**
 * On-demand token lookup: someone pasted a contract address (website search,
 * or a CA sent to the bot). Answer from the database when it is fresh; else
 * fetch the token from DEX Screener on every chain it trades, store it like a
 * scanned token, score it, and run the contract checks right away.
 */
import type { PrismaClient } from '@outis/db';
import { CHAINS, type ChainSpec, getChain } from '@outis/shared';
import { classifyTokens } from './launchpads';
import { mergeObservations } from './merge';
import { flushProviderHealth, persistMergedPairs, recomputePrimaryPairs } from './persist';
import { DexScreenerProvider } from './providers/dexscreener';
import { GoPlusProvider } from './risk/goplus';
import { DEFAULT_RISK_JOB, assessTokens, checkContract } from './risk/assess';
import { type HealthCounter, HealthRecorder, type ProviderContext } from './providers/types';

const EVM = /0x[0-9a-fA-F]{40}/;
const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
/** Market data younger than this is served from the database without a fetch. */
export const LOOKUP_FRESH_MS = 2 * 60_000;
/** Contract checks younger than this are not repeated. */
const CONTRACT_FRESH_MS = 60 * 60_000;

/**
 * The address in a message, if any: a bare CA, or one inside a link
 * (dexscreener.com/solana/…, pump.fun/coin/…, basescan.org/token/0x…).
 * For Solana-looking strings the longest base58 run wins (mints are 32–44 chars).
 */
export function extractAddress(text: string): { family: 'evm' | 'solana'; address: string } | null {
  const evm = text.match(EVM);
  if (evm) return { family: 'evm', address: evm[0].toLowerCase() };
  const runs = (text.match(BASE58) ?? []).filter((r) => r.length >= 32 && r.length <= 44 && !/^[0-9]+$/.test(r));
  if (runs.length === 0) return null;
  return { family: 'solana', address: runs.sort((a, b) => b.length - a.length)[0] };
}

/** dexscreener.com/<chain>/<pool> — DS lowercases Solana ids in links, so these need DS to resolve them. */
const DS_LINK = /dexscreener\.com\/([a-z0-9-]+)\/([A-Za-z0-9]{32,66})/i;

export interface LookupHit {
  tokenId: string;
  chainId: string;
  address: string;
}

export interface LookupResult {
  query: string;
  /** No address-like string in the input. */
  invalid: boolean;
  hits: LookupHit[];
  /** Set when the input was a pool (pair) address rather than the token's. */
  resolvedFrom?: 'pair';
  /** True when a live fetch ran (the token was missing or stale). */
  fetched: boolean;
  errors: string[];
}

export interface LookupOptions {
  now?: () => Date;
  fetchImpl?: ProviderContext['fetchImpl'];
  /** Run GoPlus checks for tokens not checked in the last hour (default true). */
  contractChecks?: boolean;
}

export async function lookupToken(prisma: PrismaClient, input: string, opts: LookupOptions = {}): Promise<LookupResult> {
  const now = opts.now ?? (() => new Date());
  let found = extractAddress(input.trim());
  const link = input.match(DS_LINK);
  if (link) {
    const chain = CHAINS.find((c) => c.providerIds.dexscreener === link[1].toLowerCase());
    if (chain) {
      const ds = new DexScreenerProvider({ health: new HealthRecorder(), fetchImpl: opts.fetchImpl, now });
      const r = await ds.refreshPairs(chain, [link[2]]);
      const base = r.data[0]?.baseToken.address;
      if (base) found = { family: chain.family === 'solana' ? 'solana' : 'evm', address: base };
    }
  }
  const result: LookupResult = { query: input.trim().slice(0, 200), invalid: !found, hits: [], fetched: false, errors: [] };
  if (!found) return result;
  if (link && found.address !== link[2]) result.resolvedFrom = 'pair';
  const { family } = found;
  let address = found.address;
  let resolved = address;

  const known = await prisma.token.findMany({
    where: { OR: [{ address }, { pairs: { some: { address } } }] },
    include: { pairs: { where: { isPrimary: true }, select: { marketUpdatedAt: true } } },
  });
  const fresh = known.length > 0 && known.every((t) => t.pairs[0]?.marketUpdatedAt && now().getTime() - t.pairs[0].marketUpdatedAt.getTime() < LOOKUP_FRESH_MS);

  const health = new HealthRecorder();
  const touched = new Set<string>();
  if (!fresh) {
    result.fetched = true;
    const ds = new DexScreenerProvider({ health, fetchImpl: opts.fetchImpl, now });
    const chains: ChainSpec[] = CHAINS.filter((c) => c.providerIds.dexscreener && (family === 'evm' ? c.family === 'evm' : c.family === 'solana'));
    const r = await ds.searchToken(address, chains);
    result.errors.push(...r.errors);
    // Only pools where the searched token is the base token; DS also returns pools quoting it.
    // A pasted PAIR address (e.g. a dexscreener.com/solana/<pair> link) resolves to its base token.
    const viaPair = r.data.find((o) => o.pairAddress === address)?.baseToken.address;
    const target = r.data.some((o) => o.baseToken.address === address) ? address : (viaPair ?? address);
    if (target !== address) result.resolvedFrom = 'pair';
    resolved = target;
    const obs = r.data.filter((o) => o.baseToken.address === target).map((o) => ({ ...o, reason: 'lookup' as const }));
    for (const chainId of new Set(obs.map((o) => o.chainId))) {
      const merged = mergeObservations(obs.filter((o) => o.chainId === chainId));
      // A searched token is stored whatever its liquidity: the user asked about it.
      const p = await persistMergedPairs(prisma, merged, { ingestMinLiquidityUsd: 0, now: now() }, getChain);
      await recomputePrimaryPairs(prisma, p.touchedTokenIds);
      p.touchedTokenIds.forEach((id) => touched.add(id));
    }
  }

  address = resolved;
  const tokens = await prisma.token.findMany({
    where: { OR: [{ address }, { pairs: { some: { address: found.address } } }] },
    include: { pairs: { select: { address: true, isPrimary: true, liquidityUsd: true } } },
  });
  if (touched.size) await classifyTokens(prisma, [...touched], now());

  if (opts.contractChecks !== false) {
    const goplus = new GoPlusProvider({ health, fetchImpl: opts.fetchImpl });
    for (const t of tokens) {
      if (t.contractCheckedAt && now().getTime() - t.contractCheckedAt.getTime() < CONTRACT_FRESH_MS) continue;
      const c = await checkContract(prisma, goplus, t, DEFAULT_RISK_JOB, now);
      if (c.kind === 'error') result.errors.push(`contract check: ${c.message}`);
      touched.add(t.id);
    }
  }
  if (touched.size) await assessTokens(prisma, [...touched], { now: now() });
  await flushProviderHealth(prisma, health.all() as HealthCounter[]).catch(() => undefined);

  // Most liquid first, so a single best answer is hits[0].
  const liq = (t: (typeof tokens)[number]) => t.pairs.find((p) => p.isPrimary)?.liquidityUsd ?? -1;
  result.hits = tokens.sort((a, b) => liq(b) - liq(a)).map((t) => ({ tokenId: t.id, chainId: t.chainId, address: t.address }));
  return result;
}
