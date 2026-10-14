/**
 * One bounded discovery scan.
 *
 * Designed for a scheduler that starts a fresh process each time (GitHub
 * Actions cron), not a resident worker:
 *  - a lease makes overlapping runs a no-op instead of double work;
 *  - a wall-clock deadline is checked between steps, so the scan always ends,
 *    records what it did, and releases its lease well inside the job timeout;
 *  - every write is idempotent (upserts, snapshot rows unique per minute), so a
 *    run that dies half-way and is retried does not duplicate anything;
 *  - the refresh step always takes the stalest pairs first, so successive runs
 *    walk the whole tracked set without needing a fragile offset cursor.
 *
 * The same function runs unchanged inside a long-lived worker later.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@outis/db';
import { type ChainSpec, type PairObservation, getChain } from '@outis/shared';
import type { ScanConfig } from './config';
import type { FetchLike, Sleep } from './http';
import { acquireLease, releaseLease, renewLease } from './lease';
import type { Logger } from './logger';
import { mergeObservations } from './merge';
import { classifyTokens } from './launchpads';
import { assessTokens } from './risk/assess';
import {
  emptyPersistStats,
  flushProviderHealth,
  persistMergedPairs,
  pruneSnapshots,
  pruneTokens,
  recomputePrimaryPairs,
  syncChains,
  type PersistStats,
} from './persist';
import { DexScreenerProvider } from './providers/dexscreener';
import { GeckoTerminalProvider } from './providers/geckoterminal';
import { HealthRecorder } from './providers/types';

export const DISCOVERY_JOB = 'discovery-scan';

export interface ScanDeps {
  prisma: PrismaClient;
  config: ScanConfig;
  logger: Logger;
  trigger: string;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  signal?: AbortSignal;
  now?: () => Date;
  holder?: string;
}

export interface ChainScanStats {
  newPools: number;
  listingTokens: number;
  refreshed: number;
  malformed: number;
  providerErrors: string[];
  persist: PersistStats;
}

export interface ScanResult {
  runId: string | null;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  chains: Record<string, ChainScanStats>;
  snapshotsPruned: number;
  tokensPruned: number;
  assessed: number;
  durationMs: number;
  stoppedEarly: string | null;
}

function addPersist(into: PersistStats, from: PersistStats): void {
  into.pairsCreated += from.pairsCreated;
  into.pairsUpdated += from.pairsUpdated;
  into.tokensCreated += from.tokensCreated;
  into.snapshotsWritten += from.snapshotsWritten;
  into.skippedBelowFloor += from.skippedBelowFloor;
  into.skippedInverted += from.skippedInverted;
  into.failed += from.failed;
  into.errors.push(...from.errors.slice(0, 10 - into.errors.length));
}

export async function runDiscoveryScan(deps: ScanDeps): Promise<ScanResult> {
  const { prisma, config, logger } = deps;
  const startedAt = Date.now();
  const deadline = startedAt + config.maxDurationMs;
  const holder = deps.holder ?? `${process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : 'local'}-${randomUUID().slice(0, 8)}`;
  // The lease outlives the deadline by a margin so finalization can't be pre-empted.
  const leaseTtl = config.maxDurationMs + 120_000;
  const result: ScanResult = {
    runId: null,
    status: 'ok',
    chains: {},
    snapshotsPruned: 0,
    tokensPruned: 0,
    assessed: 0,
    durationMs: 0,
    stoppedEarly: null,
  };

  if (!(await acquireLease(prisma, DISCOVERY_JOB, holder, leaseTtl))) {
    logger.warn('scan skipped: another scan holds the lease');
    const run = await prisma.scanRun.create({
      data: {
        job: DISCOVERY_JOB,
        trigger: deps.trigger,
        status: 'skipped',
        chains: config.chains.map((c) => c.id),
        finishedAt: new Date(),
        error: 'Another scan held the lease.',
      },
    });
    return { ...result, runId: run.id, status: 'skipped', durationMs: Date.now() - startedAt };
  }

  const run = await prisma.scanRun.create({
    data: { job: DISCOVERY_JOB, trigger: deps.trigger, status: 'running', chains: config.chains.map((c) => c.id) },
  });
  result.runId = run.id;
  logger.info('scan started', { runId: run.id, chains: config.chains.map((c) => c.id), holder });

  const health = new HealthRecorder();
  const ctx = { fetchImpl: deps.fetchImpl, sleep: deps.sleep, signal: deps.signal, health, now: deps.now };
  const gt = new GeckoTerminalProvider(ctx);
  const ds = new DexScreenerProvider(ctx);

  const outOfTime = (step: string): boolean => {
    if (deps.signal?.aborted) {
      result.stoppedEarly ??= `shutdown requested before ${step}`;
      return true;
    }
    if (Date.now() >= deadline) {
      result.stoppedEarly ??= `deadline reached before ${step}`;
      return true;
    }
    return false;
  };

  for (const c of config.chains) {
    result.chains[c.id] = {
      newPools: 0,
      listingTokens: 0,
      refreshed: 0,
      malformed: 0,
      providerErrors: [],
      persist: emptyPersistStats(),
    };
  }

  const touchedTokens = new Set<string>();
  const persist = async (chain: ChainSpec, observations: PairObservation[]) => {
    const stats = result.chains[chain.id];
    const merged = mergeObservations(observations);
    const p = await persistMergedPairs(
      prisma,
      merged,
      { ingestMinLiquidityUsd: config.ingestMinLiquidityUsd, now: deps.now?.() },
      getChain,
    );
    await recomputePrimaryPairs(prisma, p.touchedTokenIds);
    await classifyTokens(prisma, p.touchedTokenIds, deps.now?.());
    for (const id of p.touchedTokenIds) touchedTokens.add(id);
    addPersist(stats.persist, p);
  };

  try {
    await syncChains(prisma);

    // 1. Listings (DEX Screener profiles/boosts/takeovers) — one global call set.
    const listingsByChain = new Map<string, Map<string, PairObservation['reason']>>();
    if (!outOfTime('listings')) {
      const listings = await ds.latestListings(config.chains);
      for (const ref of listings.data) {
        let m = listingsByChain.get(ref.chain.id);
        if (!m) listingsByChain.set(ref.chain.id, (m = new Map()));
        if (!m.has(ref.tokenAddress)) m.set(ref.tokenAddress, ref.reason);
      }
      if (listings.errors.length) logger.warn('listing errors', { errors: listings.errors });
    }

    for (const chain of config.chains) {
      const stats = result.chains[chain.id];

      // 2. New pools (GeckoTerminal) + pairs of newly listed tokens (DEX Screener).
      if (outOfTime(`discovery on ${chain.id}`)) break;
      const observations: PairObservation[] = [];
      if (gt.supports(chain)) {
        // Priority-1 chains get the configured depth; the rest one page, so a wide
        // scan stays inside GeckoTerminal's per-minute budget.
        const r = await gt.newPools(chain, chain.priority === 1 ? config.newPoolPages : 1);
        stats.newPools = r.data.length;
        stats.malformed += r.malformed;
        stats.providerErrors.push(...r.errors);
        observations.push(...r.data);
      }
      const listed = listingsByChain.get(chain.id);
      if (listed && listed.size > 0 && ds.supports(chain) && !outOfTime(`listing pairs on ${chain.id}`)) {
        const r = await ds.pairsForTokens(chain, [...listed.keys()], (addr) => listed.get(addr) ?? 'token_profile');
        stats.listingTokens = listed.size;
        stats.malformed += r.malformed;
        stats.providerErrors.push(...r.errors);
        observations.push(...r.data);
      }
      // Fill DEX Screener's view of fresh GT pools in the same pass, so both
      // sources are attributed from the start.
      const gtPairs = observations.filter((o) => o.source === 'geckoterminal').map((o) => o.pairAddress);
      if (gtPairs.length > 0 && ds.supports(chain) && !outOfTime(`cross-check on ${chain.id}`)) {
        const r = await ds.refreshPairs(chain, gtPairs);
        stats.malformed += r.malformed;
        stats.providerErrors.push(...r.errors);
        observations.push(...r.data.map((o) => ({ ...o, reason: 'new_pool' as const })));
      }
      await persist(chain, observations);
      await prisma.ingestionCheckpoint.upsert({
        where: { key: `discovery:${chain.id}` },
        create: { key: `discovery:${chain.id}`, cursor: { lastRunAt: new Date().toISOString(), newPools: stats.newPools } },
        update: { cursor: { lastRunAt: new Date().toISOString(), newPools: stats.newPools } },
      });
      await renewLease(prisma, DISCOVERY_JOB, holder, leaseTtl);

      // 3. Refresh the stalest tracked pairs still inside the refresh window.
      if (config.refreshLimit > 0 && ds.supports(chain) && !outOfTime(`refresh on ${chain.id}`)) {
        const since = new Date(Date.now() - config.refreshMaxAgeHours * 60 * 60_000);
        const justWritten = new Date(Date.now() - 60_000);
        // Pairs we are following (open signals, open paper trades) are refreshed first:
        // gaps in their price history would turn real outcomes into "no data".
        const followed = new Set([
          ...(await prisma.signal.findMany({ where: { status: 'tracking', chainId: chain.id }, select: { pairId: true }, distinct: ['pairId'] })).map((x) => x.pairId),
          ...(await prisma.paperTrade.findMany({ where: { status: 'open', chainId: chain.id }, select: { pairId: true } })).map((x) => x.pairId),
        ]);
        const priority = followed.size
          ? await prisma.pair.findMany({
              where: { id: { in: [...followed] }, OR: [{ marketUpdatedAt: null }, { marketUpdatedAt: { lt: justWritten } }] },
              take: config.refreshLimit,
              select: { address: true },
            })
          : [];
        const others = await prisma.pair.findMany({
          where: {
            chainId: chain.id,
            OR: [{ pairCreatedAt: { gte: since } }, { pairCreatedAt: null, firstSeenAt: { gte: since } }],
            AND: [{ OR: [{ marketUpdatedAt: null }, { marketUpdatedAt: { lt: justWritten } }] }],
          },
          orderBy: [{ refreshAttemptedAt: { sort: 'asc', nulls: 'first' } }],
          take: config.refreshLimit,
          select: { address: true },
        });
        const stale = [...priority, ...others.filter((o) => !priority.some((p) => p.address === o.address))].slice(0, config.refreshLimit);
        if (stale.length > 0) {
          await prisma.pair.updateMany({
            where: { chainId: chain.id, address: { in: stale.map((p) => p.address) } },
            data: { refreshAttemptedAt: new Date() },
          });
          const r = await ds.refreshPairs(
            chain,
            stale.map((p) => p.address),
          );
          stats.refreshed = r.data.length;
          stats.malformed += r.malformed;
          stats.providerErrors.push(...r.errors);
          await persist(chain, r.data);
        }
        await prisma.ingestionCheckpoint.upsert({
          where: { key: `refresh:${chain.id}` },
          create: { key: `refresh:${chain.id}`, cursor: { lastRunAt: new Date().toISOString(), refreshed: stats.refreshed } },
          update: { cursor: { lastRunAt: new Date().toISOString(), refreshed: stats.refreshed } },
        });
        await renewLease(prisma, DISCOVERY_JOB, holder, leaseTtl);
      }
    }

    // Market-derived risk checks and momentum for everything this scan touched (DB-only, cheap).
    // Runs even past the deadline: it is bounded by what was touched, and skipping
    // it would leave fresh market data next to a stale assessment.
    if (!deps.signal?.aborted) {
      const a = await assessTokens(prisma, [...touchedTokens], { now: deps.now?.(), logger });
      result.assessed = a.assessed;
    }

    if (!outOfTime('pruning')) {
      result.snapshotsPruned = await pruneSnapshots(prisma, config.snapshotRetentionDays);
      result.tokensPruned = await pruneTokens(prisma, config.tokenRetentionDays);
    }

    const providerErrors = Object.values(result.chains).reduce((n, c) => n + c.providerErrors.length, 0);
    const persistFailures = Object.values(result.chains).reduce((n, c) => n + c.persist.failed, 0);
    result.status = result.stoppedEarly || providerErrors > 0 || persistFailures > 0 ? 'partial' : 'ok';
  } catch (err) {
    result.status = 'failed';
    logger.error('scan failed', { runId: run.id, error: (err as Error).message });
    await prisma.scanRun
      .update({ where: { id: run.id }, data: { error: (err as Error).message.slice(0, 1000) } })
      .catch(() => undefined);
  } finally {
    result.durationMs = Date.now() - startedAt;
    // Health and the run record are written even when the scan failed.
    await flushProviderHealth(prisma, health.all()).catch((e) =>
      logger.error('could not record provider health', { error: (e as Error).message }),
    );
    await prisma.scanRun
      .update({
        where: { id: run.id },
        data: {
          status: result.status,
          finishedAt: new Date(),
          stats: JSON.parse(
            JSON.stringify({
              chains: result.chains,
              snapshotsPruned: result.snapshotsPruned,
              tokensPruned: result.tokensPruned,
              assessed: result.assessed,
              durationMs: result.durationMs,
              stoppedEarly: result.stoppedEarly,
              requests: health.all().map((h) => ({
                provider: h.provider,
                scope: h.scope,
                requests: h.requests,
                errors: h.errors,
                rateLimited: h.rateLimited,
              })),
            }),
          ),
        },
      })
      .catch((e) => logger.error('could not finalize scan run', { error: (e as Error).message }));
    await releaseLease(prisma, DISCOVERY_JOB, holder).catch(() => undefined);
    logger.info('scan finished', {
      runId: run.id,
      status: result.status,
      durationMs: result.durationMs,
      stoppedEarly: result.stoppedEarly,
      chains: Object.fromEntries(
        Object.entries(result.chains).map(([id, c]) => [
          id,
          {
            newPools: c.newPools,
            listingTokens: c.listingTokens,
            refreshed: c.refreshed,
            created: c.persist.pairsCreated,
            updated: c.persist.pairsUpdated,
            belowFloor: c.persist.skippedBelowFloor,
            inverted: c.persist.skippedInverted,
            failed: c.persist.failed,
            providerErrors: c.providerErrors.length,
          },
        ]),
      ),
    });
  }
  return result;
}
