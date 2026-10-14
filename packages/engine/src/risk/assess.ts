/**
 * Assessment: turn stored data into a risk score and a momentum score per token.
 *
 *  assessTokens   — DB-only. Runs the market checks, merges them with cached
 *                   external check results, scores, writes the token. Cheap;
 *                   runs at the end of every discovery scan.
 *  runRiskJob     — the expensive part: external contract/holder checks
 *                   (GoPlus), rate-limited, leased, bounded. Its own job so it
 *                   runs in parallel with discovery, within its own provider
 *                   budget.
 *
 * No look-ahead: an assessment only reads data observed before it runs, and
 * every history row records when it was computed.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@outis/db';
import {
  type CheckResult,
  type ScoringConfig,
  DEFAULT_SCORING_CONFIG,
  checksFor,
  getChain,
  goplusChainId,
  notChecked,
  scoreMomentum,
  scoreRisk,
  scoringConfigSchema,
} from '@outis/shared';
import type { FetchLike, Sleep } from '../http';
import { acquireLease, releaseLease, renewLease } from '../lease';
import type { Logger } from '../logger';
import { flushProviderHealth } from '../persist';
import { HealthRecorder } from '../providers/types';
import { GoPlusProvider, evmChecksFromGoPlus, solanaChecksFromGoPlus } from './goplus';
import { marketChecks } from './market-checks';
import { type SignalInput, recordSignals } from '../paper/signals';

export const RISK_JOB = 'risk-scan';
export const SCORING_CONFIG_KEY = 'default';
const LIQUIDITY_HISTORY_HOURS = 6;
/** Write a history row at least this often even if nothing changed. */
const HISTORY_HEARTBEAT_MS = 6 * 60 * 60_000;

/** Stored config merged over defaults. An invalid stored config is ignored loudly, never half-applied. */
export async function loadScoringConfig(prisma: PrismaClient, logger?: Logger): Promise<ScoringConfig> {
  const row = await prisma.scoringConfig.findUnique({ where: { key: SCORING_CONFIG_KEY } });
  if (!row) return DEFAULT_SCORING_CONFIG;
  const parsed = scoringConfigSchema.safeParse(row.config);
  if (!parsed.success) {
    logger?.warn('stored scoring config is invalid — using defaults', { issues: parsed.error.issues.map((i) => i.path.join('.')) });
    return DEFAULT_SCORING_CONFIG;
  }
  return parsed.data as ScoringConfig;
}

type CheckRow = { checkId: string; category: string; status: string; severity: string; confidence: string; title: string; explanation: string; evidence: Prisma.JsonValue; source: string; observedAt: Date };

function rowToResult(r: CheckRow): CheckResult {
  return { ...r, evidence: (r.evidence as Record<string, unknown> | null) ?? null } as CheckResult;
}

export interface AssessStats {
  /** New signals recorded (first time a token matched a rule). */
  signals: number;
  assessed: number;
  historyRows: number;
  skippedNoPair: number;
}

export async function assessTokens(
  prisma: PrismaClient,
  tokenIds: string[],
  opts: { config?: ScoringConfig; now?: Date; logger?: Logger } = {},
): Promise<AssessStats> {
  const stats: AssessStats = { signals: 0, assessed: 0, historyRows: 0, skippedNoPair: 0 };
  if (tokenIds.length === 0) return stats;
  const config = opts.config ?? (await loadScoringConfig(prisma, opts.logger));
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - LIQUIDITY_HISTORY_HOURS * 60 * 60_000);

  // Bounded batches keep each query small on a pooled connection.
  const signalInputs: SignalInput[] = [];
  for (let i = 0; i < tokenIds.length; i += 100) {
    const batch = tokenIds.slice(i, i + 100);
    const tokens = await prisma.token.findMany({
      where: { id: { in: batch } },
      include: {
        pairs: { where: { isPrimary: true }, take: 1 },
        checks: true,
        assessments: { orderBy: { computedAt: 'desc' }, take: 1 },
      },
    });
    const primaryIds = tokens.map((t) => t.pairs[0]?.id).filter((x): x is string => Boolean(x));
    const snaps = await prisma.marketSnapshot.findMany({
      where: { pairId: { in: primaryIds }, observedAt: { gte: since, lte: now } },
      select: { pairId: true, observedAt: true, liquidityUsd: true },
      orderBy: { observedAt: 'asc' },
    });
    const snapsByPair = new Map<string, Array<{ at: Date; liquidityUsd: number | null }>>();
    for (const s of snaps) {
      const list = snapsByPair.get(s.pairId) ?? [];
      list.push({ at: s.observedAt, liquidityUsd: s.liquidityUsd });
      snapsByPair.set(s.pairId, list);
    }

    for (const t of tokens) {
      const pair = t.pairs[0];
      const chain = getChain(t.chainId);
      if (!pair || !chain) {
        stats.skippedNoPair++;
        continue;
      }
      const applicable = checksFor(chain.family);
      const market = marketChecks(
        {
          liquidityUsd: pair.liquidityUsd,
          fdvUsd: pair.fdvUsd,
          volumeH24: pair.volumeH24,
          priceUsd: pair.priceUsd,
          priceChangeH1: pair.priceChangeH1,
          priceChangeH6: pair.priceChangeH6,
          pairCreatedAt: pair.pairCreatedAt,
          marketUpdatedAt: pair.marketUpdatedAt,
          txns: pair.txns as never,
          liquidityHistory: snapsByPair.get(pair.id) ?? [],
        },
        now,
      );
      const byId = new Map<string, CheckResult>();
      for (const r of market) byId.set(r.checkId, r);
      for (const c of t.checks) if (!byId.has(c.checkId)) byId.set(c.checkId, rowToResult(c));

      const results: CheckResult[] = applicable.map((spec) => {
        if (spec.plannedReason) return notChecked(spec, spec.plannedReason, now);
        const r = byId.get(spec.id);
        if (r) return r;
        if (spec.source === 'goplus' && !goplusChainId(chain)) return notChecked(spec, `No contract-security source covers ${chain.displayName} yet.`, now);
        if (spec.source === 'goplus') return notChecked(spec, 'Contract checks have not run for this token yet (queued).', now);
        return notChecked(spec, 'Not run yet.', now);
      });

      const risk = scoreRisk(results, config.risk);
      const holder = results.find((r) => r.checkId === 'holders.concentration' && (r.status === 'flagged' || r.status === 'passed'));
      const txns = (pair.txns ?? {}) as Record<string, { buys: number | null; sells: number | null } | undefined>;
      const distrust = results.find((r) => (r.checkId === 'liq.implausible' || r.checkId === 'liq.phantom') && r.status === 'flagged');
      const momentum = scoreMomentum(
        {
          liquidityUsd: pair.liquidityUsd,
          liquidityDistrust: distrust ? `${distrust.title} flagged.` : null,
          txnsH1: pair.txnsH1,
          riskIncomplete: risk.incomplete,
          volumeM5: pair.volumeM5,
          volumeH1: pair.volumeH1,
          volumeH6: pair.volumeH6,
          buysH1: txns.h1?.buys ?? null,
          sellsH1: txns.h1?.sells ?? null,
          buyersH24: pair.buyersH24,
          ageMinutes: pair.pairCreatedAt ? (now.getTime() - pair.pairCreatedAt.getTime()) / 60_000 : null,
          priceChangeH1: pair.priceChangeH1,
          top10HolderPct: (holder?.evidence?.top10Pct as number | undefined) ?? null,
          riskScore: risk.score,
        },
        config.momentum,
      );

      const level = risk.incomplete ? `${risk.level}:incomplete` : risk.level;
      const flaggedIds = risk.flagged.map((f) => f.checkId).sort();
      const last = t.assessments[0];
      const changed =
        !last ||
        last.score !== risk.score ||
        last.level !== level ||
        last.flaggedChecks.join(',') !== flaggedIds.join(',') ||
        Math.abs((last.momentumScore ?? -100) - momentum.score) >= 5 ||
        now.getTime() - last.computedAt.getTime() >= HISTORY_HEARTBEAT_MS;

      await prisma.$transaction([
        prisma.token.update({
          where: { id: t.id },
          data: {
            riskScore: risk.score,
            riskLevel: level,
            riskCoverage: risk.coverage,
            riskAssessedAt: now,
            riskDetail: JSON.parse(JSON.stringify({ summary: risk, results })) as Prisma.InputJsonValue,
            momentumScore: momentum.score,
            momentum: JSON.parse(JSON.stringify(momentum)) as Prisma.InputJsonValue,
            momentumAt: now,
          },
        }),
        ...(changed
          ? [
              prisma.riskAssessment.create({
                data: {
                  tokenId: t.id,
                  score: risk.score,
                  level,
                  coverage: risk.coverage,
                  categories: risk.categories as unknown as Prisma.InputJsonValue,
                  flaggedChecks: flaggedIds,
                  momentumScore: momentum.score,
                  computedAt: now,
                },
              }),
            ]
          : []),
      ]);
      stats.assessed++;
      if (changed) stats.historyRows++;
      // Signals are recorded from exactly these values, at exactly this time — no later data can leak in.
      signalInputs.push({
        tokenId: t.id,
        pairId: pair.id,
        chainId: t.chainId,
        at: now,
        priceUsd: pair.priceUsd,
        liquidityUsd: pair.liquidityUsd,
        volumeH24: pair.volumeH24,
        ageMinutes: pair.pairCreatedAt ? (now.getTime() - pair.pairCreatedAt.getTime()) / 60_000 : null,
        momentumScore: momentum.score,
        riskScore: risk.score,
        riskCoverage: risk.coverage,
        graduatedMinutesAgo: t.graduatedAt ? (now.getTime() - t.graduatedAt.getTime()) / 60_000 : null,
      });
    }
  }
  stats.signals = await recordSignals(prisma, signalInputs);
  return stats;
}

// ── External checks job ───────────────────────────────────────────────────

export interface RiskJobConfig {
  /** Max tokens to send to external checks per run. */
  maxTokens: number;
  maxDurationMs: number;
  /** Re-check an answered token after this long. */
  recheckHours: number;
  /** Retry a token the provider had not indexed after this long. */
  notIndexedRetryMinutes: number;
  /** Only tokens whose primary pair is younger than this. */
  maxPairAgeHours: number;
}

export const DEFAULT_RISK_JOB: RiskJobConfig = {
  maxTokens: 30,
  maxDurationMs: 420_000,
  recheckHours: 12,
  notIndexedRetryMinutes: 20,
  maxPairAgeHours: 72,
};

export interface RiskJobDeps {
  prisma: PrismaClient;
  logger: Logger;
  trigger: string;
  config?: Partial<RiskJobConfig>;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface RiskJobResult {
  runId: string | null;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  checked: number;
  notIndexed: number;
  unsupported: number;
  errors: string[];
  stoppedEarly: string | null;
}

async function storeChecks(prisma: PrismaClient, tokenId: string, results: CheckResult[]): Promise<void> {
  await prisma.$transaction(
    results.map((r) =>
      prisma.tokenCheck.upsert({
        where: { tokenId_checkId: { tokenId, checkId: r.checkId } },
        create: { tokenId, ...r, evidence: (r.evidence ?? Prisma.JsonNull) as Prisma.InputJsonValue },
        update: { ...r, evidence: (r.evidence ?? Prisma.JsonNull) as Prisma.InputJsonValue },
      }),
    ),
  );
}

/**
 * One token's contract/holder checks via GoPlus, stored, with the next check
 * scheduled. Shared by the risk job and on-demand lookups.
 */
export async function checkContract(
  prisma: PrismaClient,
  goplus: GoPlusProvider,
  t: { id: string; chainId: string; address: string; pairs: Array<{ address: string }> },
  cfg: Pick<RiskJobConfig, 'recheckHours' | 'notIndexedRetryMinutes'>,
  clock: () => Date = () => new Date(),
): Promise<{ kind: 'ok' } | { kind: 'not_indexed' } | { kind: 'unsupported' } | { kind: 'error'; message: string }> {
  const chain = getChain(t.chainId);
  if (!chain || !goplusChainId(chain)) return { kind: 'unsupported' };
  const lookup = await goplus.tokenSecurity(chain, t.address);
  const at = clock();
  let next: Date;
  if (lookup.kind === 'ok') {
    const results = chain.family === 'solana' ? solanaChecksFromGoPlus(lookup.record, at) : evmChecksFromGoPlus(lookup.record, t.pairs.map((p) => p.address), at);
    await storeChecks(prisma, t.id, results);
    next = new Date(at.getTime() + cfg.recheckHours * 60 * 60_000);
  } else {
    next = new Date(at.getTime() + cfg.notIndexedRetryMinutes * 60_000);
  }
  await prisma.token.update({ where: { id: t.id }, data: { contractCheckedAt: at, contractNextCheckAt: next } });
  if (lookup.kind === 'ok') return { kind: 'ok' };
  if (lookup.kind === 'not_indexed') return { kind: 'not_indexed' };
  return { kind: 'error', message: lookup.kind === 'error' ? lookup.message : String(lookup.kind) };
}

export async function runRiskJob(deps: RiskJobDeps): Promise<RiskJobResult> {
  const cfg = { ...DEFAULT_RISK_JOB, ...deps.config };
  const { prisma, logger } = deps;
  const clock = deps.now ?? (() => new Date());
  const started = Date.now();
  const deadline = started + cfg.maxDurationMs;
  const holder = `${process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : 'local'}-${randomUUID().slice(0, 8)}`;
  const leaseTtl = cfg.maxDurationMs + 120_000;
  const result: RiskJobResult = { runId: null, status: 'ok', checked: 0, notIndexed: 0, unsupported: 0, errors: [], stoppedEarly: null };

  if (!(await acquireLease(prisma, RISK_JOB, holder, leaseTtl))) {
    const run = await prisma.scanRun.create({
      data: { job: RISK_JOB, trigger: deps.trigger, status: 'skipped', chains: [], finishedAt: new Date(), error: 'Another risk job held the lease.' },
    });
    logger.warn('risk job skipped: lease held');
    return { ...result, runId: run.id, status: 'skipped' };
  }
  const run = await prisma.scanRun.create({ data: { job: RISK_JOB, trigger: deps.trigger, status: 'running', chains: [] } });
  result.runId = run.id;
  const health = new HealthRecorder();
  const goplus = new GoPlusProvider({ fetchImpl: deps.fetchImpl, sleep: deps.sleep, signal: deps.signal, health });
  const assessed: string[] = [];

  try {
    const now = clock();
    const youngerThan = new Date(now.getTime() - cfg.maxPairAgeHours * 60 * 60_000);
    // Due tokens: never checked first, then the newest pairs.
    const due = await prisma.token.findMany({
      where: {
        OR: [{ contractNextCheckAt: null }, { contractNextCheckAt: { lte: now } }],
        pairs: { some: { isPrimary: true, OR: [{ pairCreatedAt: { gte: youngerThan } }, { pairCreatedAt: null }] } },
      },
      include: { pairs: { select: { address: true, isPrimary: true, pairCreatedAt: true } } },
      orderBy: [{ contractNextCheckAt: { sort: 'asc', nulls: 'first' } }, { firstSeenAt: 'desc' }],
      take: cfg.maxTokens * 3,
    });
    const unsupported = due.filter((t) => {
      const chain = getChain(t.chainId);
      return !chain || !goplusChainId(chain);
    });
    if (unsupported.length > 0) {
      // Park them so they stop occupying the queue; re-evaluated weekly in case coverage changes.
      result.unsupported = unsupported.length;
      await prisma.token.updateMany({
        where: { id: { in: unsupported.map((t) => t.id) } },
        data: { contractNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000) },
      });
      assessed.push(...unsupported.map((t) => t.id));
    }
    const queue = due.filter((t) => !unsupported.includes(t));

    for (const t of queue.slice(0, cfg.maxTokens)) {
      if (deps.signal?.aborted) {
        result.stoppedEarly = 'shutdown requested';
        break;
      }
      if (Date.now() >= deadline) {
        result.stoppedEarly = 'deadline reached';
        break;
      }
      const lookup = await checkContract(prisma, goplus, t, cfg, clock);
      if (lookup.kind === 'ok') result.checked++;
      else if (lookup.kind === 'not_indexed') result.notIndexed++;
      else if (lookup.kind === 'error' && result.errors.length < 10) result.errors.push(`${t.chainId}:${t.address}: ${lookup.message}`);
      assessed.push(t.id);
      if (assessed.length % 10 === 0) await renewLease(prisma, RISK_JOB, holder, leaseTtl);
    }

    await assessTokens(prisma, assessed, { now: clock(), logger });
    result.status = result.errors.length > 0 || result.stoppedEarly ? 'partial' : 'ok';
  } catch (err) {
    result.status = 'failed';
    logger.error('risk job failed', { error: (err as Error).message });
    await prisma.scanRun.update({ where: { id: run.id }, data: { error: (err as Error).message.slice(0, 1000) } }).catch(() => undefined);
  } finally {
    await flushProviderHealth(prisma, health.all()).catch(() => undefined);
    await prisma.scanRun
      .update({
        where: { id: run.id },
        data: {
          status: result.status,
          finishedAt: new Date(),
          stats: { checked: result.checked, notIndexed: result.notIndexed, unsupported: result.unsupported, errors: result.errors, stoppedEarly: result.stoppedEarly, durationMs: Date.now() - started },
        },
      })
      .catch(() => undefined);
    await releaseLease(prisma, RISK_JOB, holder).catch(() => undefined);
    logger.info('risk job finished', { runId: run.id, status: result.status, checked: result.checked, notIndexed: result.notIndexed, unsupported: result.unsupported, errors: result.errors.length, durationMs: Date.now() - started });
  }
  return result;
}

