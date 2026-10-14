/**
 * Wallet sync job: incremental, leased, bounded — same shape as the other jobs.
 * Least-recently-synced wallets go first, so every wallet gets its turn even
 * when one run cannot cover them all.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@outis/db';
import { type ChainSpec, getChain, normalizeAddress, walletSupport } from '@outis/shared';
import type { FetchLike, Sleep } from '../http';
import { acquireLease, releaseLease, renewLease } from '../lease';
import type { Logger } from '../logger';
import { HealthRecorder } from '../providers/types';
import { BlockscoutProvider } from './blockscout';
import { EvmRpcProvider } from './evm-rpc';
import { SolanaProvider } from './solana';
import { mergeObservations } from '../merge';
import { flushProviderHealth, persistMergedPairs, recomputePrimaryPairs } from '../persist';
import { DexScreenerProvider } from '../providers/dexscreener';
import { assessTokens } from '../risk/assess';
import { QUOTE_TOKENS, quoteUnitOf } from './positions';
import { type WalletProvider, NATIVE, toAmount } from './types';

/** Most unknown tokens to look up per wallet per run (DEX Screener, 30 per call). */
const ENRICH_LIMIT = 90;

/**
 * Tokens a tracked wallet trades that discovery never saw get looked up on
 * DEX Screener and enter the normal pipeline (reason: wallet_activity). That
 * gives them names, current prices and risk checks — so the wallet's open
 * positions can be valued. No liquidity floor: the user asked about these.
 */
async function enrichTokens(prisma: PrismaClient, chain: ChainSpec, walletId: string, health: HealthRecorder, fetchImpl?: FetchLike, sleep?: Sleep): Promise<number> {
  if (!chain.providerIds.dexscreener) return 0;
  const traded = await prisma.walletTransfer.findMany({ where: { walletId, tokenAddress: { not: NATIVE } }, distinct: ['tokenAddress'], select: { tokenAddress: true } });
  const candidates = traded.map((t) => t.tokenAddress).filter((a) => !quoteUnitOf(chain.id, a));
  if (candidates.length === 0) return 0;
  const known = new Set((await prisma.token.findMany({ where: { chainId: chain.id, address: { in: candidates } }, select: { address: true } })).map((t) => t.address));
  const missing = candidates.filter((a) => !known.has(a)).slice(0, ENRICH_LIMIT);
  if (missing.length === 0) return 0;
  const ds = new DexScreenerProvider({ fetchImpl, sleep, health });
  const r = await ds.pairsForTokens(chain, missing, () => 'wallet_activity');
  if (r.data.length === 0) return 0;
  const persisted = await persistMergedPairs(prisma, mergeObservations(r.data), { ingestMinLiquidityUsd: 0 }, getChain);
  await recomputePrimaryPairs(prisma, persisted.touchedTokenIds);
  await assessTokens(prisma, persisted.touchedTokenIds);
  return persisted.tokensCreated;
}

export const WALLET_JOB = 'wallet-sync';

export interface WalletJobConfig {
  maxWallets: number;
  maxDurationMs: number;
  /** Per wallet. */
  perWalletMs: number;
  backfillHours: number;
  maxTxFetches: number;
}

export const DEFAULT_WALLET_JOB: WalletJobConfig = {
  maxWallets: 25,
  maxDurationMs: 420_000,
  perWalletMs: 60_000,
  backfillHours: 72,
  maxTxFetches: 40,
};

export interface WalletJobDeps {
  prisma: PrismaClient;
  logger: Logger;
  trigger: string;
  config?: Partial<WalletJobConfig>;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  /** Restrict to these wallet ids (manual "sync now"). */
  walletIds?: string[];
}

export interface WalletJobResult {
  runId: string | null;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  wallets: number;
  transfers: number;
  errors: string[];
}

function providerFor(kind: string): WalletProvider {
  if (kind === 'solana_rpc') return new SolanaProvider();
  if (kind === 'blockscout') return new BlockscoutProvider();
  return new EvmRpcProvider();
}

export async function syncWallet(
  prisma: PrismaClient,
  walletId: string,
  opts: { config: WalletJobConfig; health: HealthRecorder; fetchImpl?: FetchLike; sleep?: Sleep; signal?: AbortSignal; env?: Record<string, string | undefined>; deadline: number },
): Promise<{ inserted: number; status: string; error?: string }> {
  const w = await prisma.trackedWallet.findUniqueOrThrow({ where: { id: walletId } });
  const chain = getChain(w.chainId) as ChainSpec | undefined;
  if (!chain) return { inserted: 0, status: 'error', error: 'Unknown chain' };
  const support = walletSupport(chain, opts.env ?? process.env);
  if (support.state !== 'live' || !support.source) {
    await prisma.trackedWallet.update({ where: { id: w.id }, data: { lastSyncAt: new Date(), lastSyncStatus: support.state, lastSyncError: support.note } });
    return { inserted: 0, status: support.state };
  }

  // Decimals we already know from discovery save one RPC call per token.
  const known = new Map((await prisma.token.findMany({ where: { chainId: chain.id, decimals: { not: null } }, select: { address: true, decimals: true } })).map((t) => [t.address, t.decimals]));
  const source = support.source;
  const sourceChanged = w.source !== null && w.source !== source.kind;
  try {
    const result = await providerFor(source.kind).sync(
      chain,
      w.address,
      source,
      sourceChanged ? null : ((w.syncCursor as Record<string, unknown> | null) ?? null),
      { deadline: Math.min(opts.deadline, Date.now() + opts.config.perWalletMs), backfillHours: opts.config.backfillHours, maxTxFetches: opts.config.maxTxFetches },
      { fetchImpl: opts.fetchImpl, sleep: opts.sleep, signal: opts.signal, health: opts.health, knownDecimals: (a) => known.get(a) ?? null },
    );
    const rows = result.transfers.map((t) => ({
      walletId: w.id,
      chainId: chain.id,
      txHash: t.txHash,
      logIndex: t.logIndex,
      blockNumber: t.blockNumber === null ? null : BigInt(t.blockNumber),
      blockTime: t.blockTime,
      tokenAddress: t.tokenAddress === 'native' ? 'native' : normalizeAddress(chain, t.tokenAddress),
      symbol: t.symbol ?? QUOTE_TOKENS[chain.id]?.[t.tokenAddress.toLowerCase()]?.symbol ?? QUOTE_TOKENS[chain.id]?.[t.tokenAddress]?.symbol ?? null,
      direction: t.direction,
      amount: toAmount(t.amountRaw, t.decimals),
      amountRaw: t.amountRaw,
      decimals: t.decimals,
      counterparty: t.counterparty,
      source: source.kind,
    }));
    const inserted = rows.length ? (await prisma.walletTransfer.createMany({ data: rows, skipDuplicates: true })).count : 0;
    // Best effort: a lookup failure must not fail the wallet sync.
    await enrichTokens(prisma, chain, w.id, opts.health, opts.fetchImpl, opts.sleep).catch(() => 0);
    const status = result.complete ? 'ok' : 'partial';
    await prisma.trackedWallet.update({
      where: { id: w.id },
      data: {
        syncCursor: result.cursor as object,
        lastSyncAt: new Date(),
        lastSyncStatus: status,
        lastSyncError: result.notes.length ? result.notes.join(' ') : null,
        source: source.kind,
      },
    });
    return { inserted, status };
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    await prisma.trackedWallet.update({ where: { id: w.id }, data: { lastSyncAt: new Date(), lastSyncStatus: 'error', lastSyncError: message } });
    return { inserted: 0, status: 'error', error: message };
  }
}

export async function runWalletJob(deps: WalletJobDeps): Promise<WalletJobResult> {
  const cfg = { ...DEFAULT_WALLET_JOB, ...deps.config };
  const { prisma, logger } = deps;
  const started = Date.now();
  const deadline = started + cfg.maxDurationMs;
  const holder = `${process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : 'local'}-${randomUUID().slice(0, 8)}`;
  const ttl = cfg.maxDurationMs + 120_000;
  const result: WalletJobResult = { runId: null, status: 'ok', wallets: 0, transfers: 0, errors: [] };

  if (!(await acquireLease(prisma, WALLET_JOB, holder, ttl))) {
    const run = await prisma.scanRun.create({ data: { job: WALLET_JOB, trigger: deps.trigger, status: 'skipped', chains: [], finishedAt: new Date(), error: 'Another wallet sync held the lease.' } });
    return { ...result, runId: run.id, status: 'skipped' };
  }
  const run = await prisma.scanRun.create({ data: { job: WALLET_JOB, trigger: deps.trigger, status: 'running', chains: [] } });
  result.runId = run.id;
  const health = new HealthRecorder();
  try {
    const wallets = await prisma.trackedWallet.findMany({
      where: deps.walletIds ? { id: { in: deps.walletIds } } : {},
      orderBy: [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }],
      take: cfg.maxWallets,
      select: { id: true, chainId: true, address: true },
    });
    for (const w of wallets) {
      if (Date.now() >= deadline || deps.signal?.aborted) break;
      const r = await syncWallet(prisma, w.id, { config: cfg, health, fetchImpl: deps.fetchImpl, sleep: deps.sleep, signal: deps.signal, env: deps.env, deadline });
      result.wallets++;
      result.transfers += r.inserted;
      if (r.error && result.errors.length < 10) result.errors.push(`${w.chainId}:${w.address}: ${r.error}`);
      await renewLease(prisma, WALLET_JOB, holder, ttl);
    }
    result.status = result.errors.length ? 'partial' : 'ok';
  } catch (err) {
    result.status = 'failed';
    logger.error('wallet job failed', { error: (err as Error).message });
  } finally {
    await flushProviderHealth(prisma, health.all()).catch(() => undefined);
    await prisma.scanRun
      .update({ where: { id: run.id }, data: { status: result.status, finishedAt: new Date(), stats: { wallets: result.wallets, transfers: result.transfers, errors: result.errors, durationMs: Date.now() - started } } })
      .catch(() => undefined);
    await releaseLease(prisma, WALLET_JOB, holder).catch(() => undefined);
    logger.info('wallet job finished', { runId: run.id, status: result.status, wallets: result.wallets, transfers: result.transfers, errors: result.errors.length });
  }
  return result;
}
