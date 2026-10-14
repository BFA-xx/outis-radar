/**
 * Risk model: the check catalog, result shapes and the scoring formula.
 *
 * Principles:
 *  - Every check is either run (flagged / passed), or explicitly NOT run
 *    (not_checked, with the reason). "Not checked" never counts as "passed".
 *  - A score is always shown together with its coverage — the share of
 *    applicable checks that produced a verdict. A low score at low coverage
 *    means "little is known", not "safe".
 *  - Checks are per chain family. EVM contract semantics are never applied to
 *    Solana or Tron and vice versa.
 */
import type { ChainFamily, ChainSpec } from './chains';

export const RISK_CATEGORIES = ['contract', 'holders', 'liquidity', 'market', 'data'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Confidence = 'low' | 'medium' | 'high';
export type CheckStatus = 'flagged' | 'passed' | 'not_checked' | 'not_applicable' | 'error';

export interface CheckSpec {
  id: string;
  category: RiskCategory;
  title: string;
  /** What the check looks for, in plain language. */
  description: string;
  families: ChainFamily[];
  /** Where the data comes from. */
  source: 'goplus' | 'solana_rpc' | 'market' | 'snapshots' | 'transactions';
  /** Not implemented yet — always reported as not_checked with this reason. */
  plannedReason?: string;
}

export interface CheckResult {
  checkId: string;
  category: RiskCategory;
  status: CheckStatus;
  severity: Severity;
  confidence: Confidence;
  title: string;
  explanation: string;
  evidence: Record<string, unknown> | null;
  source: string;
  observedAt: Date;
}

const EVM: ChainFamily[] = ['evm'];
const EVM_TRON: ChainFamily[] = ['evm', 'tron'];
const SOL: ChainFamily[] = ['solana'];
const ALL: ChainFamily[] = ['evm', 'solana', 'tron', 'sui', 'ton'];

export const CHECKS: readonly CheckSpec[] = [
  // ── Contract: EVM / Tron (GoPlus) ─────────────────────────────────────────
  { id: 'evm.honeypot', category: 'contract', title: 'Sell restriction / honeypot', description: 'Simulated buy/sell shows the token cannot be sold, or sells are blocked.', families: EVM_TRON, source: 'goplus' },
  { id: 'evm.tax', category: 'contract', title: 'Transfer taxes', description: 'Buy, sell or transfer tax, and whether the owner can change it.', families: EVM_TRON, source: 'goplus' },
  { id: 'evm.mint', category: 'contract', title: 'Mint function', description: 'Supply can be increased after launch.', families: EVM_TRON, source: 'goplus' },
  { id: 'evm.ownership', category: 'contract', title: 'Owner privileges', description: 'Active owner, hidden owner, or ownership that can be reclaimed after renouncing.', families: EVM_TRON, source: 'goplus' },
  { id: 'evm.trading_controls', category: 'contract', title: 'Pause / blacklist / limits', description: 'Owner can pause transfers, blacklist or whitelist wallets, or change limits.', families: EVM_TRON, source: 'goplus' },
  { id: 'evm.upgradeable', category: 'contract', title: 'Upgradeable proxy', description: 'Contract logic can be replaced by whoever controls the proxy.', families: EVM_TRON, source: 'goplus' },
  { id: 'evm.source', category: 'contract', title: 'Unverified source / dangerous calls', description: 'Source not published, self-destruct, or external calls that change behaviour.', families: EVM_TRON, source: 'goplus' },
  { id: 'evm.creator_history', category: 'contract', title: 'Deployer history', description: 'The same creator deployed tokens already identified as honeypots.', families: EVM_TRON, source: 'goplus' },
  // ── Contract: Solana (GoPlus) ─────────────────────────────────────────────
  { id: 'sol.mint_authority', category: 'contract', title: 'Mint authority', description: 'A wallet can still mint new supply.', families: SOL, source: 'goplus' },
  { id: 'sol.freeze_authority', category: 'contract', title: 'Freeze authority', description: 'A wallet can freeze holder token accounts (they could not sell).', families: SOL, source: 'goplus' },
  { id: 'sol.token2022', category: 'contract', title: 'Token-2022 extensions', description: 'Transfer fees, transfer hooks, permanent delegate (balance mutable), non-transferable or frozen-by-default accounts.', families: SOL, source: 'goplus' },
  { id: 'sol.metadata_mutable', category: 'contract', title: 'Mutable metadata', description: 'Name, symbol or image can be changed by an authority.', families: SOL, source: 'goplus' },
  // ── Holders ───────────────────────────────────────────────────────────────
  { id: 'holders.concentration', category: 'holders', title: 'Holder concentration', description: 'Share of supply in the 10 largest holders, excluding pools and burn addresses.', families: ['evm', 'tron', 'solana'], source: 'goplus' },
  { id: 'holders.creator', category: 'holders', title: 'Deployer allocation', description: 'Share of supply still held by the deployer or owner.', families: EVM_TRON, source: 'goplus' },
  // ── Liquidity ─────────────────────────────────────────────────────────────
  { id: 'liq.depth', category: 'liquidity', title: 'Liquidity depth', description: 'Reported pool liquidity in USD.', families: ALL, source: 'market' },
  { id: 'liq.lp_control', category: 'liquidity', title: 'LP control', description: 'Share of liquidity-provider tokens/positions held unlocked by a single wallet (can be pulled).', families: EVM_TRON, source: 'goplus' },
  { id: 'liq.removal', category: 'liquidity', title: 'Liquidity removal', description: 'Liquidity dropped sharply versus its recent peak.', families: ALL, source: 'snapshots' },
  { id: 'liq.implausible', category: 'liquidity', title: 'Implausible liquidity', description: 'Reported liquidity exceeds what the token could be worth (vs. FDV), or is enormous on a brand-new pair with almost no trading — usually a mispriced quote token or a fake pool.', families: ALL, source: 'market' },
  { id: 'liq.phantom', category: 'liquidity', title: 'Liquidity vs. activity mismatch', description: 'Large reported liquidity with almost no trading — the figure may not be usable depth (common on concentrated/v4 pools).', families: ALL, source: 'market' },
  // ── Market behaviour ──────────────────────────────────────────────────────
  { id: 'mkt.one_sided', category: 'market', title: 'No sells', description: 'Many buys and no sells — consistent with a sell restriction.', families: ALL, source: 'market' },
  { id: 'mkt.wash', category: 'market', title: 'Wash-trading pattern', description: 'Transaction count very high relative to distinct traders.', families: ALL, source: 'market' },
  { id: 'mkt.parabolic', category: 'market', title: 'Parabolic move', description: 'Extreme short-term price rise; these frequently reverse.', families: ALL, source: 'market' },
  { id: 'mkt.bundled_buys', category: 'market', title: 'Bundled / coordinated buying', description: 'Many wallets buying in the same block at launch, funded from one source.', families: ALL, source: 'transactions', plannedReason: 'Needs transaction-level data (Milestone 4).' },
  { id: 'mkt.wallet_links', category: 'market', title: 'Linked wallets', description: 'Top holders funded by the deployer or each other.', families: ALL, source: 'transactions', plannedReason: 'Needs wallet graph data (Milestone 4).' },
  // ── Data quality ──────────────────────────────────────────────────────────
  { id: 'data.stale', category: 'data', title: 'Stale market data', description: 'Market data has not been refreshed recently.', families: ALL, source: 'market' },
  { id: 'data.incomplete', category: 'data', title: 'Missing fields', description: 'Key market fields (liquidity, creation time, volume) are not reported.', families: ALL, source: 'market' },
];

export function checksFor(family: ChainFamily): CheckSpec[] {
  return CHECKS.filter((c) => c.families.includes(family));
}

/**
 * GoPlus chain ids, from GET https://api.gopluslabs.io/api/v1/supported_chains
 * (2026-10-11). HyperEVM (999) and Zora are not supported there.
 */
const GOPLUS_EVM = new Set([1, 56, 42161, 137, 8453, 10, 43114, 4663, 143, 9745, 146, 2741, 80094, 480, 5000, 130, 534352, 59144, 81457]);

export function goplusChainId(chain: ChainSpec): string | null {
  if (chain.family === 'solana') return 'solana';
  if (chain.family === 'tron') return 'tron';
  if (chain.family === 'evm' && chain.evmChainId && GOPLUS_EVM.has(chain.evmChainId)) return String(chain.evmChainId);
  return null;
}

// ── Scoring ────────────────────────────────────────────────────────────────

export interface RiskScoringConfig {
  /** Points a flagged check contributes, by severity (before confidence). */
  severityPoints: Record<Severity, number>;
  confidenceMultiplier: Record<Confidence, number>;
  /** A critical, high-confidence flag sets this minimum overall score. */
  criticalFloor: number;
  /** Below this coverage the level is reported as "incomplete". */
  minCoverage: number;
  levels: { caution: number; high: number; severe: number };
}

export const DEFAULT_RISK_CONFIG: RiskScoringConfig = {
  severityPoints: { info: 0, low: 5, medium: 15, high: 35, critical: 70 },
  confidenceMultiplier: { low: 0.5, medium: 0.8, high: 1 },
  criticalFloor: 85,
  minCoverage: 0.6,
  levels: { caution: 20, high: 45, severe: 70 },
};

export type RiskLevel = 'no_major_flags' | 'caution' | 'high' | 'severe';

export interface RiskScore {
  score: number;
  level: RiskLevel;
  /** True when coverage is below minCoverage — the level must be read as provisional. */
  incomplete: boolean;
  coverage: number;
  checksRun: number;
  checksApplicable: number;
  categories: Record<RiskCategory, { score: number; flagged: number; run: number; applicable: number }>;
  flagged: Array<{ checkId: string; points: number }>;
}

/** Combine probabilities-of-concern: 100·(1 − Π(1 − pᵢ/100)). Many mediums add up; nothing exceeds 100. */
function combine(points: number[]): number {
  return 100 * (1 - points.reduce((acc, p) => acc * (1 - Math.min(p, 100) / 100), 1));
}

export function scoreRisk(results: CheckResult[], cfg: RiskScoringConfig = DEFAULT_RISK_CONFIG): RiskScore {
  const relevant = results.filter((r) => r.status !== 'not_applicable');
  const run = relevant.filter((r) => r.status === 'flagged' || r.status === 'passed');
  const flagged = run
    .filter((r) => r.status === 'flagged')
    .map((r) => ({ r, points: cfg.severityPoints[r.severity] * cfg.confidenceMultiplier[r.confidence] }));

  const categories = Object.fromEntries(
    RISK_CATEGORIES.map((cat) => {
      const inCat = relevant.filter((r) => r.category === cat);
      const f = flagged.filter((x) => x.r.category === cat);
      return [
        cat,
        {
          score: Math.round(combine(f.map((x) => x.points))),
          flagged: f.length,
          run: inCat.filter((r) => r.status === 'flagged' || r.status === 'passed').length,
          applicable: inCat.length,
        },
      ];
    }),
  ) as RiskScore['categories'];

  let score = combine(flagged.map((x) => x.points));
  if (flagged.some((x) => x.r.severity === 'critical' && x.r.confidence === 'high')) score = Math.max(score, cfg.criticalFloor);
  score = Math.round(score);

  const coverage = relevant.length === 0 ? 0 : run.length / relevant.length;
  const level: RiskLevel =
    score >= cfg.levels.severe ? 'severe' : score >= cfg.levels.high ? 'high' : score >= cfg.levels.caution ? 'caution' : 'no_major_flags';

  return {
    score,
    level,
    incomplete: coverage < cfg.minCoverage,
    coverage: Math.round(coverage * 100) / 100,
    checksRun: run.length,
    checksApplicable: relevant.length,
    categories,
    flagged: flagged.map((x) => ({ checkId: x.r.checkId, points: Math.round(x.points * 10) / 10 })),
  };
}

export function notChecked(spec: CheckSpec, reason: string, observedAt: Date): CheckResult {
  return {
    checkId: spec.id,
    category: spec.category,
    status: 'not_checked',
    severity: 'info',
    confidence: 'low',
    title: spec.title,
    explanation: reason,
    evidence: null,
    source: spec.source,
    observedAt,
  };
}

export function requireCheck(id: string): CheckSpec {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown check ${id}`);
  return c;
}
