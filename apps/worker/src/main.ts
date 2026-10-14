/**
 * Worker entry point.
 *
 *   node dist/main.js [job] [--loop SECONDS]
 *
 *   job = discovery   new pairs + market refresh + market-derived risk/momentum
 *         risk        external contract/holder checks (GoPlus), then re-score
 *         wallets     tracked-wallet history (RPCs / Blockscout)
 *         evaluate    follow signals + paper trades (DB only)
 *         all         all four, in parallel (default) — each job has its own
 *                     lease and its own provider budget, so they do not contend
 *
 * Without --loop: one bounded run, then exit (cron / GitHub Actions).
 * Exit codes: 0 = ok / partial / skipped, 1 = a job failed. A partial run is a
 * normal outcome (one provider timing out); it shows on the health page.
 */
import { getPrisma } from '@outis/db';
import { classifyTokens, createLogger, loadRiskJobConfig, loadScanConfig, loadWalletJobConfig, runDiscoveryScan, runEvaluationJob, runRiskJob, runWalletJob } from '@outis/engine';
import { loadLocalEnv, requireEnv } from './env';

type Job = 'discovery' | 'risk' | 'wallets' | 'evaluate' | 'launchpads' | 'all';

async function main(): Promise<number> {
  loadLocalEnv();
  const logger = createLogger('worker');
  requireEnv('DATABASE_URL');

  const args = process.argv.slice(2);
  const job = (args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'all') as Job;
  if (!['discovery', 'risk', 'wallets', 'evaluate', 'launchpads', 'all'].includes(job)) throw new Error(`Unknown job "${job}" — use discovery, risk, wallets, evaluate, launchpads or all`);
  const loopIdx = args.indexOf('--loop');
  const loopSeconds = loopIdx >= 0 ? Math.max(60, Number(args[loopIdx + 1] ?? 300)) : null;
  const trigger = process.env.GITHUB_ACTIONS ? 'github-actions' : loopSeconds ? 'local-loop' : 'manual';
  // Validate everything up front so a bad env var fails before any work starts.
  const scanConfig = loadScanConfig();
  const riskConfig = loadRiskJobConfig();
  const walletConfig = loadWalletJobConfig();

  const controller = new AbortController();
  const stop = (sig: string) => {
    if (controller.signal.aborted) {
      logger.warn('second signal, exiting immediately', { sig });
      process.exit(130);
    }
    logger.warn('shutdown requested — finishing the current step', { sig });
    controller.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const prisma = getPrisma();
  const signal = controller.signal;
  let exitCode = 0;
  try {
    do {
      const runs: Array<Promise<{ status: string }>> = [];
      // One-off backfill: re-derive launchpad tags for every stored token.
      if (job === 'launchpads') runs.push(classifyTokens(prisma).then((r) => (logger.info('launchpads classified', { ...r }), { status: 'ok' })));
      if (job === 'discovery' || job === 'all') runs.push(runDiscoveryScan({ prisma, config: scanConfig, logger, trigger, signal }));
      if (job === 'risk' || job === 'all') runs.push(runRiskJob({ prisma, logger, trigger, signal, config: riskConfig }));
      if (job === 'wallets' || job === 'all') runs.push(runWalletJob({ prisma, logger, trigger, signal, config: walletConfig }));
      if (job === 'evaluate' || job === 'all') runs.push(runEvaluationJob({ prisma, logger, trigger }));
      const results = await Promise.all(runs);
      exitCode = results.some((r) => r.status === 'failed') ? 1 : 0;
      if (!loopSeconds || signal.aborted) break;
      await new Promise<void>((done) => {
        const t = setTimeout(done, loopSeconds * 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          done();
        });
      });
    } while (!signal.aborted);
  } finally {
    await prisma.$disconnect();
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    createLogger('worker').error('worker crashed', { error: (err as Error).message });
    process.exit(1);
  },
);
