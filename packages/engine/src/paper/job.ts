/**
 * Evaluation job: follow signals, apply paper-trade exit rules, record an
 * equity point. DB-only and cheap; runs alongside the other jobs.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@outis/db';
import { acquireLease, releaseLease } from '../lease';
import type { Logger } from '../logger';
import { evaluateSignals } from './signals';
import { evaluatePaperTrades, loadPaperConfig, snapshotPortfolio } from './trades';

export const EVALUATE_JOB = 'evaluate';

export async function runEvaluationJob(deps: { prisma: PrismaClient; logger: Logger; trigger: string; now?: Date }) {
  const { prisma, logger } = deps;
  const holder = `eval-${randomUUID().slice(0, 8)}`;
  if (!(await acquireLease(prisma, EVALUATE_JOB, holder, 10 * 60_000))) return { status: 'skipped' as const };
  const started = Date.now();
  const run = await prisma.scanRun.create({ data: { job: EVALUATE_JOB, trigger: deps.trigger, status: 'running', chains: [] } });
  try {
    const now = deps.now ?? new Date();
    const s = await evaluateSignals(prisma, now);
    const t = await evaluatePaperTrades(prisma, now);
    // Only keep an equity curve once paper trading has actually been used.
    const anyTrade = await prisma.paperTrade.count();
    if (anyTrade > 0) await snapshotPortfolio(prisma, loadPaperConfig(), now);
    await prisma.scanRun.update({ where: { id: run.id }, data: { status: 'ok', finishedAt: new Date(), stats: { signals: s, paperTrades: t, durationMs: Date.now() - started } } });
    logger.info('evaluation finished', { signalsEvaluated: s.evaluated, signalsFinished: s.finished, tradesChecked: t.checked, tradesClosed: t.closed });
    return { status: 'ok' as const, signals: s, trades: t };
  } catch (err) {
    logger.error('evaluation failed', { error: (err as Error).message });
    await prisma.scanRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), error: (err as Error).message.slice(0, 500) } }).catch(() => undefined);
    return { status: 'failed' as const };
  } finally {
    await releaseLease(prisma, EVALUATE_JOB, holder).catch(() => undefined);
  }
}
