/**
 * Persistence of merged pairs, snapshots, chains and provider health.
 *
 * Field carry-over: providers differ in what they report (only GeckoTerminal
 * reports distinct buyers; DEX Screener omits liquidity on bonding curves). A
 * refresh from one provider must not erase another provider's value, but it
 * must not make that value look fresh either. So each stored field records
 * the source and time it was observed (`fieldSources`), a missing field
 * carries the previous value with its ORIGINAL timestamp, and a carried value
 * older than CARRY_MAX_MS is dropped to null rather than shown as current.
 */
import { Prisma, type PrismaClient } from '@outis/db';
import { CHAINS, type ChainSpec, WINDOWS, type Window } from '@outis/shared';
import { type MergedPair, sumKnown } from './merge';
import type { HealthCounter } from './providers/types';

export const CARRY_MAX_MS = 6 * 60 * 60_000;

export interface FieldStamp {
  source: string;
  at: string;
}
type Stamps = Record<string, FieldStamp>;

const cap = (w: Window) => (w[0].toUpperCase() + w.slice(1)) as 'M5' | 'H1' | 'H6' | 'H24';

/** Flatten a merged pair's market fields to `key → value`. */
export function flattenMarket(m: MergedPair): Record<string, number | null> {
  const flat: Record<string, number | null> = {
    priceUsd: m.priceUsd,
    priceNative: m.priceNative,
    liquidityUsd: m.liquidityUsd,
    fdvUsd: m.fdvUsd,
    marketCapUsd: m.marketCapUsd,
  };
  for (const w of WINDOWS) {
    flat[`volume.${w}`] = m.volumeUsd[w];
    flat[`priceChange.${w}`] = m.priceChangePct[w];
    for (const k of ['buys', 'sells', 'buyers', 'sellers'] as const) flat[`txns.${w}.${k}`] = m.txns[w][k];
  }
  return flat;
}

type StoredPair = {
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volumeM5: number | null;
  volumeH1: number | null;
  volumeH6: number | null;
  volumeH24: number | null;
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH6: number | null;
  priceChangeH24: number | null;
  txns: Prisma.JsonValue;
  fieldSources: Prisma.JsonValue;
};

export function flattenStored(p: StoredPair): Record<string, number | null> {
  const flat: Record<string, number | null> = {
    priceUsd: p.priceUsd,
    priceNative: p.priceNative,
    liquidityUsd: p.liquidityUsd,
    fdvUsd: p.fdvUsd,
    marketCapUsd: p.marketCapUsd,
  };
  const txns = (p.txns ?? {}) as Record<string, Record<string, number | null> | undefined>;
  for (const w of WINDOWS) {
    flat[`volume.${w}`] = p[`volume${cap(w)}`];
    flat[`priceChange.${w}`] = p[`priceChange${cap(w)}`];
    for (const k of ['buys', 'sells', 'buyers', 'sellers'] as const) flat[`txns.${w}.${k}`] = txns[w]?.[k] ?? null;
  }
  return flat;
}

/**
 * Combine new values with stored ones. Pure, so it is unit-tested directly.
 * Returns the resulting flat values and their stamps.
 */
export function combineFields(
  incoming: Record<string, number | null>,
  incomingSources: Record<string, string | undefined>,
  incomingAt: Date,
  stored: Record<string, number | null> | null,
  storedStamps: Stamps | null,
  now: Date,
): { values: Record<string, number | null>; stamps: Stamps } {
  const values: Record<string, number | null> = {};
  const stamps: Stamps = {};
  for (const [key, value] of Object.entries(incoming)) {
    const source = incomingSources[key];
    if (value !== null && source) {
      values[key] = value;
      stamps[key] = { source, at: incomingAt.toISOString() };
      continue;
    }
    const prev = stored?.[key] ?? null;
    const prevStamp = storedStamps?.[key];
    if (prev !== null && prevStamp && now.getTime() - Date.parse(prevStamp.at) <= CARRY_MAX_MS) {
      values[key] = prev;
      stamps[key] = prevStamp;
    } else {
      values[key] = null;
    }
  }
  return { values, stamps };
}

function unflatten(values: Record<string, number | null>) {
  const txns: Record<string, Record<string, number | null>> = {};
  for (const w of WINDOWS) {
    txns[w] = {
      buys: values[`txns.${w}.buys`],
      sells: values[`txns.${w}.sells`],
      buyers: values[`txns.${w}.buyers`],
      sellers: values[`txns.${w}.sellers`],
    };
  }
  const intOrNull = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    priceUsd: values.priceUsd,
    priceNative: values.priceNative,
    liquidityUsd: values.liquidityUsd,
    fdvUsd: values.fdvUsd,
    marketCapUsd: values.marketCapUsd,
    volumeM5: values['volume.m5'],
    volumeH1: values['volume.h1'],
    volumeH6: values['volume.h6'],
    volumeH24: values['volume.h24'],
    priceChangeM5: values['priceChange.m5'],
    priceChangeH1: values['priceChange.h1'],
    priceChangeH6: values['priceChange.h6'],
    priceChangeH24: values['priceChange.h24'],
    txns,
    txnsH1: intOrNull(sumKnown(values['txns.h1.buys'], values['txns.h1.sells'])),
    txnsH24: intOrNull(sumKnown(values['txns.h24.buys'], values['txns.h24.sells'])),
    buyersH24: intOrNull(values['txns.h24.buyers']),
    sellersH24: intOrNull(values['txns.h24.sellers']),
  };
}

export function minuteBucket(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

export async function syncChains(prisma: PrismaClient, chains: readonly ChainSpec[] = CHAINS): Promise<void> {
  for (const c of chains) {
    await prisma.chain.upsert({
      where: { id: c.id },
      create: { id: c.id, displayName: c.displayName, family: c.family, evmChainId: c.evmChainId ?? null },
      update: { displayName: c.displayName, family: c.family, evmChainId: c.evmChainId ?? null },
    });
  }
}

export interface PersistOptions {
  /** New pairs below this liquidity are skipped (pairs already tracked are always updated). */
  ingestMinLiquidityUsd: number;
  now?: Date;
}

export interface PersistStats {
  pairsCreated: number;
  pairsUpdated: number;
  tokensCreated: number;
  snapshotsWritten: number;
  skippedBelowFloor: number;
  skippedInverted: number;
  failed: number;
  errors: string[];
}

export function emptyPersistStats(): PersistStats {
  return {
    pairsCreated: 0,
    pairsUpdated: 0,
    tokensCreated: 0,
    snapshotsWritten: 0,
    skippedBelowFloor: 0,
    skippedInverted: 0,
    failed: 0,
    errors: [],
  };
}

/** A pair whose base side is WETH/SOL/USDC is not a new-token candidate. */
export function isInverted(chain: ChainSpec | undefined, m: MergedPair): boolean {
  const qa = chain?.quoteAssets;
  if (!qa || qa.length === 0) return false;
  return qa.includes(m.baseToken.address) && !qa.includes(m.quoteToken.address);
}

export async function persistMergedPairs(
  prisma: PrismaClient,
  merged: MergedPair[],
  opts: PersistOptions,
  chainLookup: (id: string) => ChainSpec | undefined,
): Promise<PersistStats & { touchedTokenIds: string[] }> {
  const stats = emptyPersistStats();
  const touched = new Set<string>();
  const now = opts.now ?? new Date();

  for (const m of merged) {
    if (isInverted(chainLookup(m.chainId), m)) {
      stats.skippedInverted++;
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.pair.findUnique({
          where: { chainId_address: { chainId: m.chainId, address: m.pairAddress } },
        });
        if (!existing && m.liquidityUsd !== null && m.liquidityUsd < opts.ingestMinLiquidityUsd) {
          stats.skippedBelowFloor++;
          return;
        }

        const metaSource = m.observations[0]?.source ?? null;
        const tokenBefore = await tx.token.findUnique({
          where: { chainId_address: { chainId: m.chainId, address: m.baseToken.address } },
          select: { id: true },
        });
        const metadata = {
          ...(m.baseToken.symbol !== null && { symbol: m.baseToken.symbol }),
          ...(m.baseToken.name !== null && { name: m.baseToken.name }),
          ...(m.baseToken.decimals !== null && { decimals: m.baseToken.decimals }),
          ...(m.baseToken.imageUrl !== null && { imageUrl: m.baseToken.imageUrl }),
          ...(m.baseToken.links && Object.keys(m.baseToken.links).length > 0 && { links: m.baseToken.links as Prisma.InputJsonValue }),
        };
        const token = await tx.token.upsert({
          where: { chainId_address: { chainId: m.chainId, address: m.baseToken.address } },
          create: {
            chainId: m.chainId,
            address: m.baseToken.address,
            ...metadata,
            metadataSource: metaSource,
            metadataUpdatedAt: now,
            firstSeenSource: metaSource ?? 'unknown',
          },
          update:
            Object.keys(metadata).length > 0
              ? { ...metadata, metadataSource: metaSource, metadataUpdatedAt: now }
              : {},
          select: { id: true },
        });
        if (!tokenBefore) stats.tokensCreated++;
        touched.add(token.id);

        const { values, stamps } = combineFields(
          flattenMarket(m),
          flatSources(m),
          m.observedAt,
          existing ? flattenStored(existing) : null,
          (existing?.fieldSources as Stamps | null) ?? null,
          now,
        );
        const market = unflatten(values);

        // Earliest known creation time wins; a later report is a late indexer.
        const createdCandidates = [
          existing?.pairCreatedAt ? { at: existing.pairCreatedAt, src: existing.pairCreatedAtSource } : null,
          m.pairCreatedAt ? { at: m.pairCreatedAt, src: m.pairCreatedAtSource } : null,
        ].filter((c): c is { at: Date; src: string | null } => c !== null);
        const created = createdCandidates.sort((a, b) => a.at.getTime() - b.at.getTime())[0];

        const reasons = [...new Set([...(existing?.discoveryReasons ?? []), ...m.reasons])];
        const data = {
          dexId: m.dexId ?? existing?.dexId ?? null,
          baseTokenId: token.id,
          quoteTokenAddress: m.quoteToken.address,
          quoteTokenSymbol: m.quoteToken.symbol ?? existing?.quoteTokenSymbol ?? null,
          quoteTokenName: m.quoteToken.name ?? existing?.quoteTokenName ?? null,
          url: m.url ?? existing?.url ?? null,
          pairCreatedAt: created?.at ?? null,
          pairCreatedAtSource: created?.src ?? null,
          discoveryReasons: reasons,
          ...market,
          txns: market.txns as Prisma.InputJsonValue,
          fieldSources: stamps as unknown as Prisma.InputJsonValue,
          estimatedFields: m.estimatedFields,
          marketUpdatedAt: m.observedAt,
        };

        const pair = existing
          ? await tx.pair.update({ where: { id: existing.id }, data, select: { id: true } })
          : await tx.pair.create({ data: { chainId: m.chainId, address: m.pairAddress, ...data }, select: { id: true } });
        if (existing) stats.pairsUpdated++;
        else stats.pairsCreated++;

        const snaps = await tx.marketSnapshot.createMany({
          skipDuplicates: true,
          data: m.observations.map((o) => ({
            pairId: pair.id,
            source: o.source,
            reason: o.reason,
            observedAt: o.observedAt,
            bucket: minuteBucket(o.observedAt),
            priceUsd: o.priceUsd,
            liquidityUsd: o.liquidityUsd,
            fdvUsd: o.fdvUsd,
            marketCapUsd: o.marketCapUsd,
            volumeM5: o.volumeUsd.m5,
            volumeH1: o.volumeUsd.h1,
            volumeH24: o.volumeUsd.h24,
            txnsH1: sumKnown(o.txns.h1.buys, o.txns.h1.sells),
            txnsH24: sumKnown(o.txns.h24.buys, o.txns.h24.sells),
            buyersH1: o.txns.h1.buyers,
            sellersH1: o.txns.h1.sellers,
            priceChangeH1: o.priceChangePct.h1,
          })),
        });
        stats.snapshotsWritten += snaps.count;
      }, { maxWait: 10_000, timeout: 20_000 });
    } catch (err) {
      stats.failed++;
      // Prisma puts the actual cause on the LAST lines of its message, after the code frame.
      const reason = (err as Error).message.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
      if (stats.errors.length < 10) stats.errors.push(`${m.chainId}:${m.pairAddress}: ${reason.slice(0, 300)}`);
    }
  }

  return { ...stats, touchedTokenIds: [...touched] };
}

function flatSources(m: MergedPair): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(flattenMarket(m))) out[key] = m.fieldSources[key];
  return out;
}

/**
 * Mark each token's most liquid pair as primary. Unknown liquidity ranks last;
 * ties go to the higher 24h volume, then the older pair.
 */
export async function recomputePrimaryPairs(prisma: PrismaClient, tokenIds: string[]): Promise<number> {
  if (tokenIds.length === 0) return 0;
  return prisma.$executeRaw`
    UPDATE "Pair" p
       SET "isPrimary" = (p.id = best.id)
      FROM (
        SELECT DISTINCT ON ("baseTokenId") id, "baseTokenId"
          FROM "Pair"
         WHERE "baseTokenId" = ANY(${tokenIds}::text[])
         ORDER BY "baseTokenId", "liquidityUsd" DESC NULLS LAST, "volumeH24" DESC NULLS LAST, "firstSeenAt" ASC
      ) best
     WHERE p."baseTokenId" = best."baseTokenId"
       AND p."isPrimary" IS DISTINCT FROM (p.id = best.id)`;
}

/** Max tokens deleted per scan, so one run never stalls on a huge backlog. */
export const TOKEN_PRUNE_BATCH = 2000;

/**
 * Delete tokens nobody needs any more: first seen more than `retentionDays`
 * ago, no market update for 7 days, and not referenced by anything the user
 * cares about — a watchlist, a signal, a paper trade, or a tracked wallet's
 * transfers. Pairs, snapshots, checks and assessments go with them (cascade).
 */
export async function pruneTokens(prisma: PrismaClient, retentionDays: number, now = new Date()): Promise<number> {
  const seenBefore = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
  const quietSince = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  return prisma.$executeRaw`
    DELETE FROM "Token" WHERE id IN (
      SELECT t.id FROM "Token" t
       WHERE t."firstSeenAt" < ${seenBefore}
         AND NOT EXISTS (SELECT 1 FROM "Pair" p WHERE p."baseTokenId" = t.id AND p."marketUpdatedAt" >= ${quietSince})
         AND NOT EXISTS (SELECT 1 FROM "WatchlistItem" w WHERE w.kind = 'token' AND w."chainId" = t."chainId" AND w.address = t.address)
         AND NOT EXISTS (SELECT 1 FROM "Signal" s WHERE s."tokenId" = t.id)
         AND NOT EXISTS (SELECT 1 FROM "PaperTrade" pt WHERE pt."tokenId" = t.id)
         AND NOT EXISTS (SELECT 1 FROM "WalletTransfer" wt WHERE wt."chainId" = t."chainId" AND wt."tokenAddress" = t.address)
       LIMIT ${TOKEN_PRUNE_BATCH}
    )`;
}

export async function pruneSnapshots(prisma: PrismaClient, retentionDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
  const res = await prisma.marketSnapshot.deleteMany({ where: { observedAt: { lt: cutoff } } });
  return res.count;
}

export async function flushProviderHealth(prisma: PrismaClient, counters: HealthCounter[]): Promise<void> {
  for (const c of counters) {
    const existing = await prisma.providerHealth.findUnique({
      where: { provider_scope: { provider: c.provider, scope: c.scope } },
    });
    const consecutiveFailures =
      c.lastOk === true ? 0 : (existing?.consecutiveFailures ?? 0) + (c.lastOk === false ? 1 : 0);
    const data = {
      lastSuccessAt: c.lastSuccessAt ?? existing?.lastSuccessAt ?? null,
      lastErrorAt: c.lastErrorAt ?? existing?.lastErrorAt ?? null,
      lastError: c.lastError ?? existing?.lastError ?? null,
      lastLatencyMs: c.lastLatencyMs,
      consecutiveFailures,
    };
    await prisma.providerHealth.upsert({
      where: { provider_scope: { provider: c.provider, scope: c.scope } },
      create: {
        provider: c.provider,
        scope: c.scope,
        ...data,
        requestsTotal: c.requests,
        errorsTotal: c.errors,
        rateLimitedTotal: c.rateLimited,
      },
      update: {
        ...data,
        requestsTotal: { increment: c.requests },
        errorsTotal: { increment: c.errors },
        rateLimitedTotal: { increment: c.rateLimited },
      },
    });
  }
}
