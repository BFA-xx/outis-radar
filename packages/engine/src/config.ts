import { z } from 'zod';
import { CHAINS, type ChainSpec, getChain } from '@outis/shared';

const intFromEnv = (def: number, min: number, max: number) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : v), z.coerce.number().int().min(min).max(max));

export const scanConfigSchema = z.object({
  SCAN_CHAINS: z.string().optional(),
  SCAN_NEW_POOL_PAGES: intFromEnv(2, 1, 10),
  SCAN_INGEST_MIN_LIQUIDITY_USD: intFromEnv(500, 0, 10_000_000),
  SCAN_REFRESH_MAX_AGE_HOURS: intFromEnv(72, 1, 24 * 30),
  SCAN_REFRESH_LIMIT: intFromEnv(150, 0, 3_000),
  SCAN_MAX_DURATION_MS: intFromEnv(420_000, 10_000, 3_600_000),
  SNAPSHOT_RETENTION_DAYS: intFromEnv(14, 1, 365),
  TOKEN_RETENTION_DAYS: intFromEnv(14, 3, 365),
});

export interface ScanConfig {
  chains: ChainSpec[];
  newPoolPages: number;
  ingestMinLiquidityUsd: number;
  refreshMaxAgeHours: number;
  refreshLimit: number;
  maxDurationMs: number;
  snapshotRetentionDays: number;
  tokenRetentionDays: number;
}

/** Parse scan configuration from env. Throws with every problem listed, not just the first. */
export function loadScanConfig(env: Record<string, string | undefined> = process.env): ScanConfig {
  const parsed = scanConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid scan configuration — ${problems}`);
  }
  const e = parsed.data;
  const ids = (e.SCAN_CHAINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !getChain(id));
  if (unknown.length > 0) {
    throw new Error(`SCAN_CHAINS has unknown chain id(s): ${unknown.join(', ')}. Known: ${CHAINS.map((c) => c.id).join(', ')}`);
  }
  const chains = ids.length > 0 ? ids.map((id) => getChain(id)!) : CHAINS.filter((c) => c.discoveryEnabledByDefault);
  return {
    chains,
    newPoolPages: e.SCAN_NEW_POOL_PAGES,
    ingestMinLiquidityUsd: e.SCAN_INGEST_MIN_LIQUIDITY_USD,
    refreshMaxAgeHours: e.SCAN_REFRESH_MAX_AGE_HOURS,
    refreshLimit: e.SCAN_REFRESH_LIMIT,
    maxDurationMs: e.SCAN_MAX_DURATION_MS,
    snapshotRetentionDays: e.SNAPSHOT_RETENTION_DAYS,
    tokenRetentionDays: e.TOKEN_RETENTION_DAYS,
  };
}

export const riskJobConfigSchema = z.object({
  RISK_CHECKS_PER_RUN: intFromEnv(30, 0, 500),
  RISK_RECHECK_HOURS: intFromEnv(12, 1, 24 * 14),
  RISK_MAX_DURATION_MS: intFromEnv(420_000, 10_000, 3_600_000),
  SCAN_REFRESH_MAX_AGE_HOURS: intFromEnv(72, 1, 24 * 30),
});

/** Risk-job settings from env; same validation style as the scan config. */
export function loadRiskJobConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = riskJobConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid risk job configuration — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  return {
    maxTokens: e.RISK_CHECKS_PER_RUN,
    recheckHours: e.RISK_RECHECK_HOURS,
    maxDurationMs: e.RISK_MAX_DURATION_MS,
    maxPairAgeHours: e.SCAN_REFRESH_MAX_AGE_HOURS,
  };
}

export const walletJobConfigSchema = z.object({
  WALLET_SYNC_MAX_WALLETS: intFromEnv(25, 1, 1000),
  WALLET_BACKFILL_HOURS: intFromEnv(72, 1, 24 * 30),
  WALLET_MAX_TX_FETCHES: intFromEnv(40, 0, 1000),
  WALLET_MAX_DURATION_MS: intFromEnv(420_000, 10_000, 3_600_000),
});

export function loadWalletJobConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = walletJobConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid wallet job configuration — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  return { maxWallets: e.WALLET_SYNC_MAX_WALLETS, backfillHours: e.WALLET_BACKFILL_HOURS, maxTxFetches: e.WALLET_MAX_TX_FETCHES, maxDurationMs: e.WALLET_MAX_DURATION_MS };
}
